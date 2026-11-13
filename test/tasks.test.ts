import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openStore } from '../src/lib/store.ts'
import { defaultScope } from '../src/lib/scope.ts'
import { createTaskManager } from '../src/lib/tasks.ts'
import { createOutgoingTasks } from '../src/lib/outgoing-tasks.ts'
import { delegationEnd, delegationText } from '../src/lib/delegation.ts'
import { HttpError, type DelegateInput, type DelegateResult, type TrustedDevice, type DeviceTask } from '../src/lib/types.ts'
import type { HostEvent, HostServices } from '../src/lib/host.ts'

async function fixture(t: TestContext, run: (input: DelegateInput) => Promise<DelegateResult>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'device-tasks-'))
  const store = await openStore({ home: directory, deviceName: 'test' })
  const owner: TrustedDevice = { deviceId: 'owner', name: 'local', createdAt: '', lastSeenAt: '', tokenHash: 'token', active: true, relationship: 'same-account', scope: defaultScope('same-account') }
  await store.update(draft => { draft.trusted.owner = owner })
  const manager = await createTaskManager({ store, ctx: { get: () => undefined }, run })
  t.after(async () => { await manager.dispose(); await fs.rm(directory, { recursive: true, force: true }) })
  return { store, manager, owner, directory }
}

test('startup failures retain prompt and error as separate session evidence scoped to the submitting grant', async t => {
  const h = await fixture(t, async () => { throw new Error('model unavailable before prompt') })
  const submitted = await h.manager.submit(h.owner, {id:'startup',workspacePath:h.directory,task:'create hello.txt'})
  await h.manager.dispose()
  const [evidence] = h.manager.sessionEvidence(h.owner, submitted.sessionId)
  assert.equal(evidence.prompt, 'create hello.txt')
  assert.equal(evidence.status, 'error')
  assert.equal(evidence.error, 'model unavailable before prompt')
  assert.equal(evidence.errorPhase, 'startup')
  assert.equal(evidence.text, '')
  assert.deepEqual(h.manager.sessionEvidence({...h.owner,tokenHash:'replacement'}, submitted.sessionId), [])
  assert.deepEqual(h.manager.sessionEvidence({...h.owner,scope:{...h.owner.scope,sessionSync:'metadata'}}, submitted.sessionId), [])
})

test('task submission is idempotent and cancellation survives replay', async t => {
  let runs = 0
  const h = await fixture(t, async input => {
    runs++
    await input.onProgress?.({ sessionId: input.sessionId!, baselineSeq: 0, text: 'partial', model: 'remote-model' })
    try { await delay(10000, undefined, { signal: input.signal }) } catch {}
    return { status: 'error', sessionId: input.sessionId!, text: '', cancelled: true }
  })
  const input = { id: 'job', task: 'hello', workspacePath: h.directory, selection: { provider: 'p', model: 'model-a' } }
  const [first, second] = await Promise.all([h.manager.submit(h.owner, input), h.manager.submit(h.owner, input)])
  assert.equal(first.sessionId, second.sessionId)
  await delay(5)
  assert.equal(runs, 1)
  await assert.rejects(() => h.manager.submit(h.owner, { ...input, task: 'different' }), /already used/)
  await assert.rejects(() => h.manager.submit(h.owner, { ...input, selection: { provider: 'p', model: 'model-b' } }), /already used/)
  const stopped = await h.manager.cancel(h.owner, input.id)
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.text, 'partial')
  await assert.rejects(() => h.manager.submit(h.owner, input), /cancelled/)
  assert.equal(runs, 1)
})

test('cancel before admission prevents later execution and another grant cannot access tasks', async t => {
  let runs = 0
  const h = await fixture(t, async input => { runs++; return { status: 'completed', sessionId: input.sessionId!, text: 'done' } })
  await h.manager.cancel(h.owner, 'job')
  await assert.rejects(() => h.manager.submit(h.owner, { id: 'job', task: 'hello', workspacePath: h.directory }), /cancelled/)
  assert.equal(runs, 0)
  await h.manager.submit(h.owner, { id: 'other', task: 'hello', workspacePath: h.directory })
  assert.throws(() => h.manager.get({ ...h.owner, tokenHash: 'new-token' }, 'other'), /not found/)
  const secondOwner = { ...h.owner, deviceId: 'second-owner' }
  await h.store.update(draft => { draft.trusted[secondOwner.deviceId] = secondOwner })
  await h.manager.submit(secondOwner, { id: 'other', task: 'hello', workspacePath: h.directory })
  assert.notEqual(h.store.state().incomingTasks['owner:other'].promptRequestId, h.store.state().incomingTasks['second-owner:other'].promptRequestId)
  await h.store.update(draft => { draft.trusted.owner.scope.allowDelegate = false })
  await assert.rejects(() => h.manager.submit(h.owner, { id: 'new', task: 'hello', workspacePath: h.directory }), /grant changed/)
})

test('continuation permits one delegated request per session', async t => {
  const h = await fixture(t, async input => {
    try { await delay(10000, undefined, { signal: input.signal }) } catch {}
    return { status: 'error', sessionId: input.sessionId!, text: '', cancelled: true }
  })
  await h.manager.submit(h.owner, { id: 'one', task: 'hello', workspacePath: h.directory, sessionId: 'existing' })
  await assert.rejects(() => h.manager.submit(h.owner, { id: 'two', task: 'hello', workspacePath: h.directory, sessionId: 'existing' }), /active delegated/)
})

const events: HostEvent[] = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', data: { source: { rpcId: 'other' } } },
  { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: 'wrong' } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 4, type: 'turn/start', data: { turn: 2 } },
  { seq: 5, type: 'user/message', data: { source: { rpcId: 'device-link-job' } } },
  { seq: 6, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'right' }] } } },
  { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
]
test('delegation result belongs to the admitted request turn', () => {
  assert.equal(delegationEnd(events, 0, 'device-link-job')?.seq, 7)
  assert.equal(delegationText(events, 0, 'device-link-job'), 'right')
  assert.equal(delegationEnd(events, 0, 'missing'), undefined)
})

test('restart reconciles durable completion without submitting again', async t => {
  const h = await fixture(t, async () => { throw new Error('must not run') })
  await h.store.update(draft => { draft.incomingTasks['owner:job'] = {
    id: 'job', ownerDeviceId: 'owner', tokenHash: 'token', sessionId: 'session', workspacePath: h.directory,
    prompt: 'hello', promptRequestId: 'device-link-job', resume: false, baselineSeq: 0, status: 'running', text: '', createdAt: '', updatedAt: '',
  } })
  const services: Partial<HostServices> = { sessionQuery: { listSessions: async () => [], readSession: async () => ({ session: { id: 'session', cwd: h.directory }, events }), readEvent: async () => { throw new Error('unexpected event read') } } }
  const restarted = await createTaskManager({ store: h.store, ctx: { get: name => services[name] }, run: async () => { throw new Error('must not run') } })
  assert.equal(restarted.get(h.owner, 'job').status, 'completed')
  assert.equal(restarted.get(h.owner, 'job').text, 'right')
  await restarted.dispose()
})

test('outgoing retries use one identity and completed cancellation does not loop', async t => {
  const h = await fixture(t, async () => { throw new Error('unused') })
  const peer = { deviceId: 'peer', token: 'token', name: 'peer', baseUrl: 'http://127.0.0.1:1', createdAt: '', lastSeenAt: '' }
  await h.store.update(draft => { draft.peers.peer = peer })
  let starts = 0
  let cancels = 0
  const remote: DeviceTask = { id: 'job', sessionId: 'session', workspacePath: h.directory, prompt: 'hello', status: 'running', createdAt: '', updatedAt: new Date().toISOString(), text: '' }
  const connector = {
    async readTask() { if (!starts) throw new HttpError(404, 'missing'); return { ...remote } },
    async startTask() { starts++; throw new Error('response lost') },
    async cancelTask() { cancels++; return { task: { ...remote }, cancelled: false } },
  }
  const outgoing = createOutgoingTasks({ store: h.store, connector: connector as never })
  await outgoing.start(peer, { id: 'job', workspacePath: h.directory, task: 'hello' })
  assert.equal((await outgoing.refresh('job')).remote?.status, 'running')
  assert.equal(starts, 1)
  remote.status = 'completed'
  await outgoing.cancel('job')
  await outgoing.refresh('job')
  assert.equal(outgoing.get('job').cancelRequested, undefined)
  assert.equal(cancels, 1)
})

test('outgoing wait expiry returns current state and leaves the remote task running', async t => {
  const h = await fixture(t, async () => { throw new Error('unused') })
  const peer = { deviceId: 'peer', token: 'token', name: 'peer', baseUrl: 'http://127.0.0.1:1', createdAt: '', lastSeenAt: '' }
  await h.store.update(draft => { draft.peers.peer = peer })
  let cancels = 0
  const remote: DeviceTask = { id: 'job', sessionId: 'session', workspacePath: h.directory, prompt: 'hello', status: 'running', createdAt: '', updatedAt: new Date().toISOString(), text: 'partial' }
  const connector = {
    async readTask() { return { ...remote } },
    async cancelTask() { cancels++; return { task: { ...remote, status: 'stopped' }, cancelled: true } },
  }
  const outgoing = createOutgoingTasks({ store: h.store, connector: connector as never })
  await outgoing.start(peer, { id: 'job', workspacePath: h.directory, task: 'hello' })
  const result = await outgoing.wait('job', 20)
  assert.equal(result.remote?.status, 'running')
  assert.equal(result.remote?.text, 'partial')
  assert.equal(result.submission, 'accepted')
  assert.equal(result.cancelRequested, undefined)
  assert.equal(cancels, 0)
  remote.status = 'completed'
  remote.text = 'finished after the wait'
  remote.updatedAt = new Date().toISOString()
  assert.equal((await outgoing.refresh('job')).remote?.text, 'finished after the wait')
  assert.equal(outgoing.get('job').remote?.status, 'completed')
  assert.equal(cancels, 0)
})
