import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { once } from 'node:events'
import { openStore } from '../src/lib/store.ts'
import { createPairing } from '../src/lib/pairing.ts'
import { createDeviceLinkServer } from '../src/lib/serve.ts'
import { createConnector } from '../src/lib/connect.ts'
import { normalizeBase, diagnose, updateStatus } from '../src/lib/network.ts'
import { defaultScope, normalizeScope, authorizedWorkspace } from '../src/lib/scope.ts'
import { collectHostFacts } from '../src/lib/host-facts.ts'
import type { Scope, SessionContent } from '../src/lib/types.ts'

async function harness(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-collaboration-'))
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  const store = await openStore({ home, deviceName: 'remote' })
  const local = await openStore({ home: path.join(home, 'local'), deviceName: 'local' })
  const session: SessionContent = { id: 's1', cwd: workspace, title: 'cached session', updatedAt: 1, live: true, messages: [{ role: 'assistant', text: 'offline reference text' }], truncated: false }
  const facts = await collectHostFacts({ get: () => undefined })
  facts.workspaces = [{ id: 'workspace', title: 'workspace', path: workspace }]
  facts.sessions = [session]
  facts.agents = [{ id: session.id, cwd: workspace, status: 'running' }]
  let delegates = 0
  const server = createDeviceLinkServer({ config: { port: 0, bindAddress: '127.0.0.1' }, store, pairing: createPairing(),
    proxy: { handle(_req, res) { res.end('GUI') }, handleUpgrade(_req, socket) { socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n') } },
    factsProvider: async () => facts,
    sessionProvider: async () => session,
    delegateProvider: async () => { delegates++; return { status: 'completed', sessionId: 's1', text: 'done' } },
  })
  const listen = await server.start()
  const base = `http://127.0.0.1:${listen.port}`
  const connector = createConnector({ store: local, log: { warn() {} } })
  t.after(async () => { await server.stop(); await fs.rm(home, { recursive: true, force: true }) })
  async function pair(scope = defaultScope('same-account')) {
    const grant = server.openPairing({ relationship: 'same-account', scope })
    return connector.claim(base, grant.code)
  }
  return { home, workspace, store, local, server, base, connector, pair, get delegates() { return delegates } }
}

test('addresses reject credentials, paths, alternate IP forms and public destinations', () => {
  assert.equal(normalizeBase('192.168.1.9:47654'), 'http://192.168.1.9:47654')
  assert.equal(normalizeBase('http://127.0.0.1:80'), 'http://127.0.0.1:80')
  assert.equal(normalizeBase('localhost:47654'), 'http://127.0.0.1:47654')
  for (const address of ['http://user:pass@192.168.1.9', '192.168.1.9/path', '192.168.1.9?token=x', '192.168.1.9#fragment', '8.8.8.8', '0.0.0.0', '127.1', '2130706433', '0x7f000001', '127.0.0.1:0', '127.0.0.1:65536', 'file:///etc/passwd']) {
    assert.throws(() => normalizeBase(address), undefined, address)
  }
})
test('unknown account relation starts with an empty grant and never enables full UI implicitly', () => {
  assert.deepEqual(defaultScope('unknown').workspaces, [])
  assert.equal(defaultScope('different-account').allowUi, false)
  assert.throws(() => normalizeScope({ workspaces: 'all' }), /boolean/)
  assert.throws(() => normalizeScope({ ...defaultScope('same-account'), workspaces: [process.cwd()] }), /完整界面/)
})
test('restricted token cannot bypass allowUi using Bearer, cookie, access code or websocket', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const access = await h.connector.access(peer)
  await h.server.setScope(h.local.state().identity.deviceId, { ...defaultScope('different-account'), workspaces: [h.workspace], allowDelegate: true, sessionSync: 'metadata' })
  for (const headers of [{ authorization: `Bearer ${peer.token}` }, { cookie: `dl_session=${peer.token}` }]) {
    assert.equal((await fetch(`${h.base}/`, { headers })).status, 403)
  }
  assert.equal((await fetch(access.url, { redirect: 'manual' })).status, 401)
  await assert.rejects(() => h.connector.access(peer), /grant/)
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(h.base).port) })
  const closed = once(socket, 'close')
  await once(socket, 'connect')
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${new URL(h.base).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${peer.token}\r\n\r\n`)
  await closed
})
test('revocation closes an already upgraded socket', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(h.base).port) })
  await once(socket, 'connect')
  const upgraded = once(socket, 'data')
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${new URL(h.base).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${peer.token}\r\n\r\n`)
  assert.match(String((await upgraded)[0]), /101/)
  const closed = once(socket, 'close')
  await h.server.revoke(h.local.state().identity.deviceId)
  await closed
})
test('turning incoming off blocks existing tokens and can be toggled back on', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  await h.server.setIncoming(false)
  await assert.rejects(() => h.connector.facts(peer), /disabled/)
  await h.server.setIncoming(true)
  assert.equal((await h.connector.facts(peer)).ok, true)
})
test('workspace traversal and symlink escapes are denied before delegation', async t => {
  const h = await harness(t)
  const scope: Scope = { ...defaultScope('different-account'), workspaces: [h.workspace], allowDelegate: true }
  const peer = await h.pair(scope)
  await assert.rejects(() => h.connector.delegate(peer, { workspacePath: `${h.workspace}${path.sep}..`, task: 'escape' }), /outside/)
  const outside = path.join(h.home, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(h.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => authorizedWorkspace(path.join(h.workspace, 'escape'), scope), /outside/)
  assert.equal(h.delegates, 0)
  assert.equal((await h.connector.delegate(peer, { workspacePath: h.workspace, task: 'valid' })).status, 'completed')
  assert.equal(h.delegates, 1)
})
test('cached session content survives offline and store restart', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  assert.equal((await h.connector.sync(peer, true)).online, true)
  await h.server.stop()
  const reopened = await openStore({ home: path.join(h.home, 'local') })
  const connector = createConnector({ store: reopened })
  const offline = await connector.sync(reopened.state().peers[peer.deviceId], true)
  assert.equal(offline.online, false)
  assert.equal(offline.cachedSessionIds.length, 1)
  assert.equal(connector.cachedSession(peer, 's1').session.messages[0].text, 'offline reference text')
})
test('sync scope reductions remove content and known revocation clears cache', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  await h.connector.sync(peer, true)
  assert.ok(h.connector.cachedSession(peer, 's1'))
  await h.server.setScope(h.local.state().identity.deviceId, { ...defaultScope('same-account'), allowUi: false, sessionSync: 'metadata' })
  await h.connector.sync(peer, true)
  assert.throws(() => h.connector.cachedSession(peer, 's1'), /尚未缓存/)
  await h.server.revoke(h.local.state().identity.deviceId)
  await h.connector.sync(peer, true)
  assert.equal(h.local.state().peers[peer.deviceId].cache, undefined)
})
test('session selection filters sessions and agents at the server boundary', async t => {
  const h = await harness(t)
  const peer = await h.pair({ ...defaultScope('same-account'), allowUi: false, sessionIds: [] })
  const facts = await h.connector.facts(peer)
  assert.deepEqual(facts.host.sessions, [])
  assert.deepEqual(facts.host.agents, [])
  assert.equal((await fetch(`${h.base}/dl/session?id=s1`, { headers: { authorization: `Bearer ${peer.token}` } })).status, 403)
})
test('foreign origins are rejected and forged Host cannot change entry URL', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  assert.equal((await fetch(`${h.base}/dl/access`, { method: 'POST', headers: { authorization: `Bearer ${peer.token}`, origin: 'http://evil.invalid' } })).status, 403)
  const response = await fetch(`${h.base}/dl/access`, { method: 'POST', headers: { authorization: `Bearer ${peer.token}`, host: 'evil.invalid' } })
  assert.equal(new URL((await response.json()).url).origin, h.base)
})
test('connector blocks redirect responses and ambiguous device names', async t => {
  const h = await harness(t)
  const fetchImpl: typeof fetch = async (_url, options) => { assert.equal(options?.redirect, 'error'); return new Response('{}', { status: 302, headers: { location: 'http://8.8.8.8' } }) }
  const connector = createConnector({ store: h.local, fetchImpl })
  await assert.rejects(() => connector.claim(h.base, '12345678'))
  const peer = await h.pair()
  await h.local.update(draft => { draft.peers.duplicate = { ...peer, deviceId: 'duplicate' } })
  assert.throws(() => h.connector.peerByRef(peer.name), /重复/)
})
test('store serializes concurrent updates and returns isolated snapshots', async t => {
  const h = await harness(t)
  await Promise.all(Array.from({ length: 10 }, () => h.local.update(draft => { draft.serve.port++ })))
  assert.equal(h.local.state().serve.port, 47664)
  const snapshot = h.local.state()
  snapshot.serve.port = 1
  assert.equal(h.local.state().serve.port, 47664)
  await assert.rejects(() => h.local.update(draft => { draft.serve.port = 3; throw new Error('rollback') }))
  assert.equal(h.local.state().serve.port, 47664)
})
test('failed atomic writes leave the committed in-memory state intact', async t => {
  const h = await harness(t)
  const before = h.local.state()
  t.mock.method(fs, 'rename', async () => { throw new Error('simulated disk failure') })
  await assert.rejects(() => h.local.update(draft => { draft.serve.port = 99 }), /disk failure/)
  assert.deepEqual(h.local.state(), before)
})
test('diagnostics distinguish address, protocol, and ready states', async t => {
  const h = await harness(t)
  assert.equal((await diagnose('8.8.8.8')).stage, 'address')
  assert.equal((await diagnose(h.base)).stage, 'ready')
  assert.equal(updateStatus('0.2.0'), 'current')
  assert.equal(updateStatus('0.3.0'), 'remote-newer')
  assert.equal(updateStatus('0.1.0'), 'remote-older')
})
