import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { collectHostFacts, readSessionContent, lastAssistantText } from '../src/lib/host-facts.ts'
import { isPathAllowed, defaultScope } from '../src/lib/scope.ts'
import { createDelegationRunner } from '../src/lib/delegation.ts'
import type { HostContext, HostEvent, HostServices, HostSession } from '../src/lib/host.ts'

const root = path.resolve('workspace')
function context(services: Partial<HostServices>): Pick<HostContext, 'get'> {
  return { get: name => services[name] }
}
const session = (id: string, cwd = root): HostSession => ({ id, header: { id, cwd, createdAt: 1234 }, title: id, seq: 0, snapshotEvents: () => [], deriveMessages: () => [] })

test('host facts contain device runtime and tolerate absent optional services', async () => {
  const facts = await collectHostFacts(context({}), { startedAt: 123 })
  assert.equal(facts.platform, process.platform)
  assert.equal(facts.startedAt, 123)
  assert.deepEqual(facts.sessions, [])
  assert.deepEqual(facts.agents, [])
})
test('workspace entities are projected to JSON-safe fields including getter-backed paths', async () => {
  class WorkspaceEntity {
    readonly id = 'workspace-entity'
    readonly internalOwner = { workspace: this }
    get path() { return root }
    get title() { return 'Workspace entity' }
  }
  const facts = await collectHostFacts(context({ workspaceRegistry: { list: () => [new WorkspaceEntity()] } }))
  const serialized = JSON.parse(JSON.stringify(facts))
  assert.deepEqual(serialized.workspaces, [{ id: 'workspace-entity', path: root, title: 'Workspace entity' }])
})
test('facts merge live and historical sessions, apply workspace and session filters', async () => {
  const current = session('live')
  const ctx = context({
    workspaceRegistry: { list: () => [{ id: 'root', path: root, title: 'root' }, { id: 'outside', path: path.resolve('outside'), title: 'outside' }] },
    sessions: { list: () => [current], get: () => current },
    sessionQuery: { listSessions: async () => [{ header: current.header, live: true }, { header: session('cold').header, live: false }], readSession: async () => ({ session: current.header, events: [] }) },
    agents: { list: () => [{ id: 'live', session: current, status: 'running', options: { model: 'remote-model' } }], get: () => undefined },
  })
  const scope = { ...defaultScope('different-account'), workspaces: [root], sessionSync: 'metadata' as const, sessionIds: ['live', 'cold'] }
  const facts = await collectHostFacts(ctx, { scope })
  assert.deepEqual(facts.workspaces.map(item => item.id), ['root'])
  assert.equal(facts.sessions.length, 2)
  assert.equal(facts.sessions.find(item => item.id === 'cold')?.live, false)
  assert.equal(facts.agents[0].model, 'remote-model')
  const hidden = await collectHostFacts(ctx, { scope: { ...scope, sessionSync: 'none' } })
  assert.deepEqual(hidden.sessions, [])
  assert.deepEqual(hidden.agents, [])
})
test('path checks normalize traversal and retain platform case rules', () => {
  assert.equal(isPathAllowed(path.join(root, 'child'), [root]), true)
  assert.equal(isPathAllowed(`${root}${path.sep}..${path.sep}outside`, [root]), false)
  assert.equal(isPathAllowed(root + '-sibling', [root]), false)
  assert.equal(isPathAllowed('relative', 'all'), false)
  assert.equal(isPathAllowed(root, []), false)
  assert.equal(isPathAllowed(root.toUpperCase(), [root]), process.platform === 'win32')
})
test('content sync returns bounded user/assistant text and refuses metadata grants', async () => {
  const current = session('live')
  current.deriveMessages = () => [{ role: 'user', content: 'internal model context must stay out of transcript' }]
  current.snapshotEvents = () => [
    { type: 'user/message', seq: 0, data: { content: 'hello', source: { kind: 'user' } } },
    { type: 'user/message', seq: 1, data: { content: 'internal runtime context', source: { kind: 'runtime-context' } } },
    { type: 'tool/result', seq: 1, data: { content: 'secret output' } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'x'.repeat(70000) }] } } },
  ]
  const ctx = context({ sessions: { list: () => [current], get: () => current } })
  const content = await readSessionContent(ctx, 'live', defaultScope('same-account'))
  assert.equal(content.messages.map(item => item.text).join('').length, 64000)
  assert.equal(content.truncated, true)
  assert.equal(content.messages.some(item => item.text.includes('private')), false)
  assert.equal(content.messages.some(item => item.text.includes('internal model context')), false)
  const events = current.snapshotEvents()
  events[3].data.message = { content: 'answer' }
  current.snapshotEvents = () => events
  assert.deepEqual((await readSessionContent(ctx, 'live', defaultScope('same-account'))).messages.map(({role,text}) => ({role,text})), [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'answer' }])
  await assert.rejects(() => readSessionContent(ctx, 'live', { ...defaultScope('same-account'), sessionSync: 'metadata' }), /disabled/)
})
test('archived content uses sessionQuery without resuming its agent', async () => {
  const cold = session('cold')
  const ctx = context({ sessionQuery: {
    listSessions: async () => [{ header: cold.header, live: false }],
    readSession: async () => ({ session: cold.header, events: [{ type: 'assistant/message', seq: 0, data: { message: { content: [{ type: 'text', text: 'history' }] } } }] }),
  } })
  assert.equal((await readSessionContent(ctx, 'cold', defaultScope('same-account'))).messages[0].text, 'history')
})
function delegationHarness({ end = true, fail = false } = {}) {
  const events: HostEvent[] = []
  let canceled = 0
  let created = ''
  const current = session('task')
  current.seq = 1
  current.snapshotEvents = () => events
  current.deriveMessages = () => [{ role: 'assistant', content: 'remote answer' }]
  const ctx = context({ sessions: { get: () => current, list: () => [current] }, sessionController: {
    async create(input) { created = input.cwd; return { sessionId: input.sessionId } },
    async prompt() { if (end) setTimeout(() => events.push({ seq: 1, type: 'turn/end', data: { reason: fail ? { kind: 'error', error: { message: 'provider failed' } } : { kind: 'completed' } } }), 10) },
    async cancel() { canceled++ },
  } })
  return { runner: createDelegationRunner({ ctx }), get canceled() { return canceled }, get created() { return created } }
}
test('delegation uses the host UI creation/prompt services and waits for durable turn end', async () => {
  const harness = delegationHarness()
  const result = await harness.runner.run({ workspacePath: root, task: 'hello' })
  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'remote answer')
  assert.equal(harness.created, root)
})
test('delegation reports provider failure instead of an empty success', async () => {
  const result = await delegationHarness({ fail: true }).runner.run({ workspacePath: root, task: 'hello' })
  assert.equal(result.status, 'error')
  assert.match(result.error!, /provider failed/)
})
test('delegation timeout preserves the remote session', async () => {
  const harness = delegationHarness({ end: false })
  assert.equal((await harness.runner.run({ workspacePath: root, task: 'hello', timeoutMs: 10 })).status, 'timeout')
  assert.equal(harness.canceled, 0)
})
test('authorization cancellation cancels the remote task', async () => {
  const harness = delegationHarness({ end: false })
  const abort = new AbortController()
  const result = harness.runner.run({ workspacePath: root, task: 'hello', signal: abort.signal })
  setTimeout(() => abort.abort(), 10)
  assert.equal((await result).status, 'error')
  assert.equal(harness.canceled, 1)
})
test('plugin disposal cancels owned work and rejects further delegation', async () => {
  const harness = delegationHarness({ end: false })
  const result = harness.runner.run({ workspacePath: root, task: 'hello' })
  await harness.runner.disposeAll()
  assert.equal((await result).status, 'error')
  await assert.rejects(() => harness.runner.run({ workspacePath: root, task: 'hello' }), /stopping/)
})
test('delegation validates task and directory before creating a session', async () => {
  const { runner } = delegationHarness()
  await assert.rejects(() => runner.run({ workspacePath: 'relative', task: 'hello' }), /absolute/)
  await assert.rejects(() => runner.run({ workspacePath: root, task: '  ' }), /required/)
})
test('last assistant text collects text blocks', () => {
  assert.equal(lastAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]), 'ab')
})
