import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createResourceProvider, queryCachedSession, queryEvidence, type ResourceRequest } from '../src/lib/resources.ts'
import { defaultScope } from '../src/lib/scope.ts'
import { evidenceEvent, cacheEvidence } from '../src/lib/evidence.ts'
import { openStore } from '../src/lib/store.ts'
import { createReferences } from '../src/lib/references.ts'
import { createConnector } from '../src/lib/connect.ts'
import { createPairing } from '../src/lib/pairing.ts'
import { createDeviceLinkServer } from '../src/lib/serve.ts'
import { collectHostFacts, readSessionContent } from '../src/lib/host-facts.ts'
import type { HostContext, HostEvent, HostServices } from '../src/lib/host.ts'
import { APP_VERSION, API_VERSION, type RemoteStatus, type CachedSession } from '../src/lib/types.ts'

async function temporary(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'device-resource-'))
  t.after(async () => { if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('device-resource-')) throw new Error('invalid test directory'); await fs.rm(directory, { recursive: true, force: true }) })
  return directory
}

test('empty resource results distinguish an empty directory, excluded files and a missed query', async t => {
  const root = await temporary(t)
  const provider = createResourceProvider({ get: () => undefined })
  const scope = defaultScope('same-account')
  const input: ResourceRequest = { kind: 'workspace', workspacePath: root, action: 'inspect' }
  const empty = await provider(input, scope)
  assert.equal(empty.emptyReason, 'empty-directory')
  assert.equal(empty.truncated, false)
  await fs.writeFile(path.join(root, '.env'), 'private')
  assert.equal((await provider(input, scope)).emptyReason, 'no-readable-files')
  assert.equal((await provider({ ...input, action: 'search', query: 'not-present' }, scope)).emptyReason, 'no-readable-files')
  await fs.writeFile(path.join(root, 'source.ts'), 'export const answer = 42')
  assert.equal((await provider({ ...input, action: 'search', query: 'not-present' }, scope)).emptyReason, 'no-matches')
  await assert.rejects(provider(input, { ...scope, allowReadFiles: false }), { status: 403 })
  const session: ResourceRequest = { kind: 'session', sessionId: 's1', workspacePath: root, action: 'inspect' }
  assert.equal(queryEvidence([], session, 'device', 'now', false).emptyReason, 'no-events')
})
test('workspace reads enforce grants, path boundaries, file versions and text pagination', async t => {
  const directory = await temporary(t)
  const root = path.join(directory, 'work'); await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'api.ts'), 'function createInvoice() {}\n' + 'next line\n'.repeat(130))
  await fs.writeFile(path.join(directory, 'outside'), 'private')
  await fs.writeFile(path.join(root, '.env'), 'private')
  const provider = createResourceProvider({ get: () => undefined })
  const request: ResourceRequest = { kind: 'workspace', workspacePath: root, action: 'search', query: 'createInvoice' }
  const scope = { ...defaultScope('different-account'), workspaces: [root], allowReadFiles: true }
  const found = await provider(request, scope)
  assert.equal(found.items[0].path, 'api.ts')
  const read = { ...request, action: 'read' as const, path: 'api.ts', revision: found.items[0].revision }
  const result = await provider(read, scope)
  assert.equal(result.items[0].endLine, 120)
  assert.equal(result.items[0].nextLine, 121)
  assert.match((await provider({ ...read, startLine: 121 }, scope)).items[0].text!, /next line/)
  await assert.rejects(() => provider(request, { ...scope, allowReadFiles: false }), { status: 403 })
  for (const filename of ['../outside', path.join(directory, 'outside'), '.env']) await assert.rejects(() => provider({ ...read, path: filename }, scope), { status: 403 })
  await fs.writeFile(path.join(root, 'api.ts'), 'changed')
  await assert.rejects(() => provider(read, scope), { status: 409 })
  await fs.symlink(directory, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => provider({ ...read, path: 'escape/outside' }, scope), { status: 403 })
  await fs.unlink(path.join(root, 'escape'))
})
function sessionHarness(root: string) {
  const events: HostEvent[] = [
    { seq: 0, type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: '决定不用 Redis，先使用内存缓存。' } },
    { seq: 1, type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'reasoning', text: 'secret reasoning' }, { type: 'text', text: '已记录 Redis 决策' }] } } },
    { seq: 2, type: 'tool/result', time: 3, data: { message: { content: [{ type: 'text', text: 'FAIL expected 200 received 401' }] } } },
    { seq: 3, type: 'request/header', data: { authorization: 'secret key' } },
  ]
  let snapshots = 0; let reads = 0
  const session = { id: 's1', header: { id: 's1', cwd: root }, seq: 4, snapshotEvents: () => events }
  const services: Partial<HostServices> = {
    sessions: { list: () => [session], get: () => session },
    workspaceRegistry: { list: () => [{ id: 'work', path: root, title: 'work' }] },
    sessionQuery: { listSessions: async () => [{ header: session.header, live: true }], readSession: async () => { snapshots++; return { session: session.header, events } },
      readEvent: async input => { reads++; return { session: session.header, target: events.find(event => event.seq === input.seq)!, events } },
    },
  }
  const ctx: Pick<HostContext, 'get'> = { get: name => services[name] }
  return { ctx, events, session, calls: () => ({ snapshots, reads }) }
}
test('each session query uses one source observation and enforces explicit tool-result sharing', async t => {
  const root = await temporary(t)
  const h = sessionHarness(root); const provider = createResourceProvider(h.ctx)
  const scope = defaultScope('same-account')
  const request: ResourceRequest = { kind: 'session', workspacePath: root, sessionId: 's1', action: 'search', query: 'FAIL' }
  assert.equal((await provider(request, scope)).items.length, 0)
  const found = await provider(request, { ...scope, sessionTools: true })
  assert.equal(found.items[0].seq, 2)
  const read = await provider({ ...request, action: 'read', seq: 2, revision: found.items[0].revision }, { ...scope, sessionTools: true })
  assert.match(read.items[0].text!, /received 401/)
  assert.deepEqual(h.calls(), { snapshots: 2, reads: 1 })
  assert.equal((await provider({ ...request, query: 'secret' }, { ...scope, sessionTools: true })).items.length, 0)
  await assert.rejects(() => provider(request, { ...scope, sessionIds: [] }), { status: 403 })
  h.events[2].data.message = { content: 'different failure' }
  await assert.rejects(() => provider({ ...request, action: 'read', seq: 2, revision: found.items[0].revision }, { ...scope, sessionTools: true }), { status: 409 })
})

test('resource reads distinguish missing sessions and events from host persistence failures', async t => {
  const root = await temporary(t)
  const h = sessionHarness(root)
  const query = h.ctx.get('sessionQuery')!
  let failure = Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  query.readSession = query.readEvent = async () => { throw failure }
  const provider = createResourceProvider(h.ctx)
  const input: ResourceRequest = { kind: 'session', workspacePath: root, sessionId: 's1', action: 'inspect' }
  await assert.rejects(() => provider(input, defaultScope('same-account')), { status: 404 })
  failure = Object.assign(new Error('event not found'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' })
  await assert.rejects(() => provider({ ...input, action: 'read', seq: 999, revision: 'a'.repeat(64) }, defaultScope('same-account')), { status: 404 })
  failure = Object.assign(new Error('disk read failed'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  await assert.rejects(() => provider(input, defaultScope('same-account')), error => error === failure)
})

test('file reads preserve empty lines and include separators in the page size limit', async t => {
  const root = await temporary(t)
  const provider = createResourceProvider({ get: () => undefined })
  const scope = { ...defaultScope('same-account'), workspaces: [root] }
  for (const text of ['\n\nbody\n', 'a'.repeat(15_999) + '\nb']) {
    await fs.writeFile(path.join(root, 'source.txt'), text)
    const input: ResourceRequest = { kind: 'workspace', workspacePath: root, action: 'inspect' }
    const item = (await provider(input, scope)).items[0]
    const result = await provider({ ...input, action: 'read', path: item.path, revision: item.revision }, scope)
    assert.equal(result.items[0].text, text.length > 16_000 ? text.slice(0, 15_999) : text)
    assert.ok(result.items[0].text!.length <= 16_000)
    if (text.length > 16_000) assert.equal(result.items[0].nextLine, 2)
  }
})

test('sensitive resource names cannot be bypassed with case variants', async t => {
  const root = await temporary(t)
  await fs.writeFile(path.join(root, '.ENV'), 'secret configuration')
  const provider = createResourceProvider({ get: () => undefined })
  const scope = defaultScope('same-account')
  const input: ResourceRequest = { kind: 'workspace', workspacePath: root, action: 'inspect' }
  assert.deepEqual((await provider(input, scope)).items, [])
  await assert.rejects(provider({ ...input, action: 'read', path: '.ENV', revision: '0'.repeat(64) }, scope), { status: 403 })
})

test('file reads consume short reads before hashing and reject non-UTF-8 text', async t => {
  const root = await temporary(t)
  const text = 'complete source content across several reads'
  await fs.writeFile(path.join(root, 'source.txt'), text)
  const open = fs.open.bind(fs)
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    const read = file.read.bind(file)
    const shortRead = async (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 7), position)
    t.mock.method(file, 'read', shortRead as typeof file.read)
    return file
  })
  const provider = createResourceProvider({ get: () => undefined })
  const input: ResourceRequest = { kind: 'workspace', workspacePath: root, action: 'inspect' }
  const item = (await provider(input, defaultScope('same-account'))).items[0]
  const result = await provider({ ...input, action: 'read', path: item.path, revision: item.revision }, defaultScope('same-account'))
  assert.equal(result.items[0].text, text)
  await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x41]))
  await assert.rejects(provider({ ...input, action: 'read', path: 'invalid.txt', revision: '0'.repeat(64) }, defaultScope('same-account')), { status: 415 })
})

test('evidence pagination reports omitted events and partial event pages', () => {
  const events = Array.from({ length: 21 }, (_, seq) => evidenceEvent({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: `message ${seq}` } }, false)!)
  const input: ResourceRequest = { kind: 'session', sessionId: 's1', workspacePath: '/work', action: 'inspect' }
  const result = queryEvidence(events, input, 'device', 'now', false)
  assert.equal(result.items.length, 20)
  assert.equal(result.items[0].seq, 1)
  assert.equal(result.truncated, true)
  const long = evidenceEvent({ seq: 30, type: 'user/message', data: { source: { kind: 'user' }, content: 'x'.repeat(13_000) } }, false)!
  assert.equal(queryEvidence([long], { ...input, action: 'read', seq: long.seq, revision: long.revision }, 'device', 'now', false).truncated, true)
})

test('cached resource queries reject missing event evidence instead of inventing sequence numbers', () => {
  const session = { id: 's1', cwd: '/work', title: '', live: false, updatedAt: 0, messages: [{ role: 'user', text: 'legacy body' }], truncated: false, cachedAt: 'now' } as unknown as CachedSession
  assert.throws(() => queryCachedSession(session, { kind: 'session', sessionId: 's1', workspacePath: '/work', action: 'inspect' }, false), { status: 409 })
  const valid = evidenceEvent(sessionHarness('/work').events[0], false)!
  for (const changed of [{ seq: -1 }, { seq: '1' }, { type: 'request/header' }, { text: null }, { revision: 'old' }, { truncated: undefined }, { time: 'yesterday' }]) {
    const malformed = { ...session, evidence: [{ ...valid, ...changed }], evidenceTruncated: false } as unknown as CachedSession
    assert.throws(() => queryCachedSession(malformed, { kind: 'session', sessionId: 's1', workspacePath: '/work', action: 'inspect' }, false), { status: 409 })
  }
})
test('offline evidence preserves exact source revisions, scope and bounded coverage', () => {
  const h = sessionHarness('/work')
  const cache = cacheEvidence(h.events, true)
  const session = { id: 's1', cwd: '/work', title: 'decision', updatedAt: 1, live: false, messages: [], truncated: false, cachedAt: '2026-11-12T00:00:00Z', ...cache }
  const request: ResourceRequest = { kind: 'session', workspacePath: '/work', sessionId: 's1', action: 'search', query: 'Redis' }
  const result = queryCachedSession(session, request, false)
  assert.equal(result.source, 'cache'); assert.equal(result.observedAt, session.cachedAt)
  assert.equal(result.items.length, 2)
  assert.equal(queryCachedSession(session, { ...request, query: 'FAIL' }, false).items.length, 0)
  assert.equal(queryCachedSession(session, { ...request, query: 'FAIL' }, true).items.length, 1)
  assert.equal(evidenceEvent(h.events[3], true), undefined)
  const long = cacheEvidence([{ seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: 'a'.repeat(70_000) } }], false)
  assert.equal(long.evidenceTruncated, true)
  const page = queryCachedSession({ ...session, ...long }, { ...request, action: 'read', seq: 10, revision: long.evidence[0].revision }, false)
  assert.equal(page.items[0].text!.length, 12_000); assert.equal(page.items[0].nextOffset, 12_000)
})
test('preview does not create agent receipts; receipts persist by local session and revoke denies access', async t => {
  const root = await temporary(t); const store = await openStore({ home: root })
  const status: RemoteStatus = { ok: true, api: API_VERSION, device: { deviceId: 'peer', name: 'Peer', app: 'dsh-device-link', version: APP_VERSION }, scope: defaultScope('same-account'), host: { ...await collectHostFacts({ get: () => undefined }), workspaces: [{ id: 'w', title: 'Workspace', path: root }] } }
  await store.update(draft => { draft.peers.peer = { deviceId: 'peer', name: 'Peer', baseUrl: 'http://127.0.0.1:1', token: 'token', createdAt: '', lastSeenAt: '', cache: { status, syncedAt: '', sessions: {} } } })
  const connector = createConnector({ store, fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { action: 'inspect', source: 'device', observedAt: 'now', items: [{ title: 'file.ts' }], coverage: 'current files', truncated: false } }), { status: 200 }) })
  const references = await createReferences({ store, connector })
  const descriptor = await references.prepare('peer', { workspacePath: root })
  assert.equal(JSON.stringify(descriptor).includes('token'), false)
  await references.query(descriptor.id, { action: 'inspect' })
  assert.equal(references.get(descriptor.id, 'local').receipts.length, 0)
  await references.query(descriptor.id, { action: 'inspect' }, { localSessionId: 'local', callId: 'call' })
  assert.equal(references.get(descriptor.id, 'other').receipts.length, 0)
  const reloaded = await createReferences({ store, connector })
  assert.equal(reloaded.get(descriptor.id, 'local').receipts[0].result.items[0].title, 'file.ts')
  await store.update(draft => { delete draft.peers.peer })
  assert.throws(() => references.get(descriptor.id, 'local'), { status: 403 })
})

test('reference views refresh capabilities and cache timestamps without exposing mutable receipts', async t => {
  const root = await temporary(t); const store = await openStore({ home: root }); const h = sessionHarness(root)
  const scope = { ...defaultScope('same-account'), sessionTools: true }
  const content = await readSessionContent(h.ctx, 's1', scope)
  const status: RemoteStatus = { ok: true, api: API_VERSION, device: { deviceId: 'peer', name: 'Peer', app: 'dsh-device-link', version: APP_VERSION }, scope, host: await collectHostFacts(h.ctx) }
  await store.update(draft => {
    draft.peers.peer = { deviceId: 'peer', name: 'Peer', baseUrl: 'http://127.0.0.1:1', token: 'token', createdAt: '', lastSeenAt: '',
      cache: { status, syncedAt: '', sessions: { s1: { ...content, cachedAt: '2026-11-12T00:00:00Z' } } } }
  })
  const connector = createConnector({ store, fetchImpl: async () => Response.json({ ok: true, result: {
    action: 'inspect', source: 'device', observedAt: 'now', items: [{ title: 'original', type: 'user/message' }], coverage: 'text', truncated: false,
  } }) })
  const references = await createReferences({ store, connector })
  const descriptor = await references.prepare('peer', { sessionId: 's1' })
  const response = await references.query(descriptor.id, { action: 'inspect' }, { localSessionId: 'local', callId: 'call' })
  response.items[0].title = 'mutated response'
  assert.equal(references.get(descriptor.id, 'local').receipts[0].result.items[0].title, 'original')
  references.get(descriptor.id, 'local').receipts[0].result.items[0].title = 'mutated detail'
  references.call('local', 'call')!.receipt.result.items[0].title = 'mutated call'
  assert.equal(references.get(descriptor.id, 'local').receipts[0].result.items[0].title, 'original')
  await store.update(draft => {
    draft.peers.peer.cache!.status.scope.sessionTools = false
    delete draft.peers.peer.cache!.sessions.s1
  })
  for (const view of [references.get(descriptor.id).descriptor, references.call('local', 'call')!.descriptor]) {
    assert.equal(view.capabilities.includes('读取工具调用与结果'), false)
    assert.equal(view.availability, 'unavailable')
    assert.equal(view.cachedAt, undefined)
  }
})
test('server rejects resource responses when authorization changes during a read', async t => {
  const root = await temporary(t); const store = await openStore({ home: root })
  let finish!: () => void; let started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const wait = new Promise<void>(resolve => { finish = resolve })
  const server = createDeviceLinkServer({ config: { port: 0, bindAddress: '127.0.0.1' }, store, pairing: createPairing(),
    proxy: { handle() {}, handleUpgrade() {} }, resourceProvider: async () => { started(); await wait; return { action: 'inspect', source: 'device', observedAt: '', items: [], truncated: false, coverage: '' } } })
  const listen = await server.start(); t.after(() => server.stop())
  const pairing = server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
  const local = await openStore({ home: path.join(root, 'local') }); const connector = createConnector({ store: local })
  const peer = await connector.claim(`http://127.0.0.1:${listen.port}`, pairing.code)
  const request = connector.resource(peer, { kind: 'workspace', workspacePath: root, action: 'inspect' })
  await began; await server.setScope(local.state().identity.deviceId, defaultScope('different-account')); finish()
  await assert.rejects(() => request, { status: 403 })
})

test('connection loss reads cached events but explicit denial never falls back', async t => {
  const root = await temporary(t); const store = await openStore({ home: root }); const h = sessionHarness(root)
  const content = await readSessionContent(h.ctx, 's1', defaultScope('same-account'))
  const status: RemoteStatus = { ok: true, api: API_VERSION, device: { deviceId: 'peer', name: 'Peer', app: '', version: APP_VERSION }, scope: defaultScope('same-account'), host: await collectHostFacts(h.ctx) }
  await store.update(draft => { draft.peers.peer = { deviceId: 'peer', name: 'Peer', baseUrl: 'http://127.0.0.1:1', token: 'token', createdAt: '', lastSeenAt: '', cache: { status, syncedAt: '', sessions: { s1: { ...content, cachedAt: '2026-11-12T00:00:00Z' } } } } })
  let denied = false
  const connector = createConnector({ store, fetchImpl: async () => { if (denied) return new Response(JSON.stringify({ ok: false, error: 'revoked' }), { status: 403 }); throw new TypeError('offline') } })
  const peer = store.state().peers.peer
  const request: ResourceRequest = { kind: 'session', workspacePath: root, sessionId: 's1', action: 'search', query: 'Redis' }
  assert.equal((await connector.resource(peer, request)).source, 'cache')
  denied = true
  await assert.rejects(() => connector.resource(peer, request), { status: 403 })
  assert.equal(store.state().peers.peer.cache, undefined)
})
