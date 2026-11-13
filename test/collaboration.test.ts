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
import { defaultScope, normalizeScope } from '../src/lib/scope.ts'
import { collectHostFacts } from '../src/lib/host-facts.ts'
import { createTaskManager } from '../src/lib/tasks.ts'
import type { Scope, SessionContent } from '../src/lib/types.ts'
import { APP_VERSION, HttpError } from '../src/lib/types.ts'
import { renameDevice } from '../src/lib/identity.ts'
import { revisionOf } from '../src/lib/evidence.ts'

async function harness(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-collaboration-'))
  const workspace = path.join(home, 'workspace')
  await fs.mkdir(workspace)
  const store = await openStore({ home, deviceName: 'remote' })
  const local = await openStore({ home: path.join(home, 'local'), deviceName: 'local' })
  const session: SessionContent = { id: 's1', cwd: workspace, title: 'cached session', updatedAt: 1, live: true,
    messages: [{ role: 'assistant', seq: 0, text: 'offline reference text' }], truncated: false, evidence: [], evidenceTruncated: false }
  const sessionContents = new Map([[session.id, session]])
  const facts = await collectHostFacts({ get: () => undefined })
  facts.workspaces = [{ id: 'workspace', title: 'workspace', path: workspace }]
  facts.sessions = [session]
  facts.agents = [{ id: session.id, cwd: workspace, status: 'running' }]
  let delegates = 0
  const taskManager = await createTaskManager({store,ctx:{get:()=>undefined},run:async input=>{
    delegates++
    return {status:'completed',sessionId:input.sessionId!,text:'done'}
  }})
  const server = createDeviceLinkServer({ config: { port: 0, bindAddress: '127.0.0.1' }, store, pairing: createPairing(),
    proxy: { handle(_req, res) { res.end('GUI') }, handleUpgrade(_req, socket) { socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n') } },
    factsProvider: async () => facts,
    sessionProvider: async (id, scope) => {
      const content = sessionContents.get(id)
      if (!content) throw new HttpError(404, 'session is unavailable')
      return { ...content, evidence: content.evidence.filter(event => scope.sessionTools || !event.type.startsWith('tool/')) }
    },
    taskManager,
    executionProvider: async () => ({catalog:{default:{provider:'p',model:'m'},groups:[],failures:[]},selected:{provider:'p',model:'m'},busy:false}),
  })
  const listen = await server.start()
  const base = `http://127.0.0.1:${listen.port}`
  const connector = createConnector({ store: local, log: { warn() {} } })
  t.after(async () => { await taskManager.dispose(); await server.stop(); await fs.rm(home, { recursive: true, force: true }) })
  async function pair(scope = defaultScope('same-account')) {
    const grant = server.openPairing({ relationship: 'same-account', scope })
    return connector.claim(base, grant.code)
  }
  return { home, workspace, store, local, server, base, connector, pair, session, sessionContents, facts, get delegates() { return delegates } }
}

async function archivedHarness(t: TestContext) {
  const h = await harness(t)
  const archived = { ...h.session, id: 'archived', live: false }
  h.sessionContents.set(archived.id, archived)
  h.facts.sessions = Array.from({ length: 200 }, (_, i) => ({ ...h.session, id: `recent-${i}` }))
  return { ...h, archived }
}

test('renames sync in both directions without changing grants and survive offline restart', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const trustedBefore = h.server.trusted()[0]
  await renameDevice(h.store, ' 办公室电脑 ')
  await renameDevice(h.local, '开发笔记本')
  const view = await h.connector.sync(peer, true)
  assert.equal(view.name, '办公室电脑')
  assert.equal(view.online, true)
  assert.equal(h.local.state().peers[peer.deviceId].token, peer.token)
  assert.deepEqual(h.server.trusted()[0], { ...trustedBefore, name: '开发笔记本' })
  assert.equal(h.connector.peerByRef('办公室电脑')?.deviceId, peer.deviceId)
  assert.equal(h.connector.peerByRef('remote'), undefined)
  const renamedId = h.store.state().identity.deviceId
  const reopenedRemote = await openStore({ home: h.home, deviceName: 'remote' })
  assert.equal(reopenedRemote.state().identity.name, '办公室电脑')
  assert.equal(reopenedRemote.state().identity.deviceId, renamedId)
  await h.server.stop()
  const reopenedLocal = await openStore({ home: path.join(h.home, 'local'), deviceName: 'local' })
  const offline = await createConnector({ store: reopenedLocal }).sync(reopenedLocal.state().peers[peer.deviceId], true)
  assert.equal(offline.name, '办公室电脑')
  assert.equal(offline.online, false)
  assert.equal(reopenedLocal.state().identity.name, '开发笔记本')
})

test('invalid or unauthenticated name announcements cannot alter a trusted device', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const before = h.server.trusted()
  assert.equal((await fetch(`${h.base}/dl/status`, { headers: { 'x-device-link-name': encodeURIComponent('冒名') } })).status, 401)
  assert.equal((await fetch(`${h.base}/dl/status`, { headers: { authorization: `Bearer ${peer.token}`, 'x-device-link-name': '%E0%A4' } })).status, 400)
  assert.deepEqual(h.server.trusted(), before)
  const identity = h.store.state().identity
  for (const value of ['', '   ', 'a\nb', 'a'.repeat(65), null]) await assert.rejects(renameDevice(h.store, value), HttpError)
  assert.deepEqual(h.store.state().identity, identity)
})

test('addresses reject credentials, paths, alternate IP forms and public destinations', () => {
  assert.equal(normalizeBase('192.168.1.9:47654'), 'http://192.168.1.9:47654')
  assert.equal(normalizeBase('http://127.0.0.1:80'), 'http://127.0.0.1:80')
  assert.equal(normalizeBase('localhost:47654'), 'http://127.0.0.1:47654')
  for (const address of ['http://user:pass@192.168.1.9', '192.168.1.9/path', '192.168.1.9?token=x', '192.168.1.9#fragment', '8.8.8.8', '0.0.0.0', '127.1', '2130706433', '0x7f000001', '127.0.0.1:0', '127.0.0.1:65536', 'file:///etc/passwd']) {
    assert.throws(() => normalizeBase(address), { name: 'Error' }, address)
  }
})

test('execution model context obeys delegation and session scope, including owned tasks without history sync',async t=>{
  const h=await harness(t)
  const scope={...defaultScope('different-account'),workspaces:[h.workspace],allowDelegate:true,sessionSync:'none' as const}
  const peer=await h.pair(scope)
  assert.equal((await h.connector.execution(peer,h.workspace)).selected.model,'m')
  await assert.rejects(()=>h.connector.execution(peer,h.workspace,'s1'),/未授权继续/)
  await assert.rejects(()=>h.connector.execution(peer,h.home),/scope|authorized|grant/)
  const task=await h.connector.startTask(peer,{requestId:'owned',workspacePath:h.workspace,task:'hello'})
  assert.equal((await h.connector.execution(peer,h.workspace,task.sessionId)).selected.model,'m')
  await h.server.setScope(h.local.state().identity.deviceId,{...scope,allowDelegate:false})
  await assert.rejects(()=>h.connector.execution(peer,h.workspace),/delegation disabled/)
})
test('unknown account relation starts with an empty grant and never enables full UI implicitly', () => {
  assert.deepEqual(defaultScope('unknown').workspaces, [])
  assert.equal(defaultScope('different-account').allowUi, false)
  assert.throws(() => normalizeScope({ workspaces: 'all' }), /boolean/)
  assert.throws(() => normalizeScope({ ...defaultScope('same-account'), workspaces: [process.cwd()] }), /完整界面/)
})

test('new grants require explicit file and tool permissions', () => {
  for (const field of ['allowReadFiles', 'sessionTools']) {
    for (const value of [undefined, null, 'true', 1]) {
      assert.throws(() => normalizeScope({ ...defaultScope('same-account'), [field]: value }), /must be boolean/)
    }
  }
  assert.equal(normalizeScope({ ...defaultScope('different-account'), sessionTools: true }).sessionTools, false)
})

test('status responses must carry the current permission fields', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const status = await h.connector.facts(peer)
  for (const field of ['allowReadFiles', 'sessionTools']) {
    const connector = createConnector({ store: h.local, fetchImpl: async () => Response.json({ ...status, scope: { ...status.scope, [field]: undefined } }) })
    await assert.rejects(() => connector.facts(peer), /protocol mismatch/)
  }
})
test('restricted token cannot bypass allowUi using Bearer, cookie, access code or websocket', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const access = await h.connector.access(peer)
  await h.server.setScope(h.local.state().identity.deviceId, { ...defaultScope('different-account'), workspaces: [h.workspace], allowDelegate: true, sessionSync: 'metadata' })
  const headersToCheck: Record<string, string>[] = [{ authorization: `Bearer ${peer.token}` }, { cookie: `dl_session=${peer.token}` }]
  for (const headers of headersToCheck) {
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
  await assert.rejects(() => h.connector.startTask(peer, { requestId: 'traversal', workspacePath: `${h.workspace}${path.sep}..`, task: 'escape' }), /outside/)
  const outside = path.join(h.home, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(h.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => h.connector.startTask(peer, { requestId: 'symlink', workspacePath: path.join(h.workspace, 'escape'), task: 'escape' }), /outside/)
  assert.equal(h.delegates, 0)
  const submitted = await h.connector.startTask(peer, { requestId: 'valid', workspacePath: h.workspace, task: 'valid' })
  let completed = submitted
  for (let attempt = 0; attempt < 100 && completed.status !== 'completed'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    completed = await h.connector.readTask(peer, submitted.id)
  }
  assert.equal(completed.status, 'completed')
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

test('store backs up incomplete schemas without silently filling missing collections', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-store-schema-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  for (const field of ['favorites', 'incomingTasks', 'outgoingTasks', 'taskCancellations']) {
    const caseHome = path.join(home, field)
    const store = await openStore({ home: caseHome })
    const invalid: Record<string, unknown> = { ...store.state() }
    delete invalid[field]
    const source = JSON.stringify(invalid)
    await fs.writeFile(store.path, source)
    const reopened = await openStore({ home: caseHome, log: { warn() {} } })
    assert.notEqual(reopened.state().identity.deviceId, store.state().identity.deviceId)
    const backups = (await fs.readdir(store.directory)).filter(name => name.includes('.corrupt-'))
    assert.equal(backups.length, 1)
    assert.equal(await fs.readFile(path.join(store.directory, backups[0]), 'utf8'), source)
  }
})

test('store read failures preserve the existing file and identity', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-store-io-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const store = await openStore({ home })
  const before = await fs.readFile(store.path, 'utf8')
  const read = t.mock.method(fs, 'readFile', async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }) })
  await assert.rejects(openStore({ home }), /read denied/)
  read.mock.restore()
  assert.equal(await fs.readFile(store.path, 'utf8'), before)
  assert.deepEqual(await fs.readdir(store.directory), [path.basename(store.path)])
})

test('store backup failures do not overwrite invalid source data', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-store-backup-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const store = await openStore({ home })
  await fs.writeFile(store.path, '{broken')
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('backup denied') })
  await assert.rejects(openStore({ home }), /backup denied/)
  rename.mock.restore()
  assert.equal(await fs.readFile(store.path, 'utf8'), '{broken')
})
test('diagnostics distinguish address, protocol, and ready states', async t => {
  const h = await harness(t)
  assert.equal((await diagnose('8.8.8.8')).stage, 'address')
  assert.equal((await diagnose(h.base)).stage, 'ready')
  assert.equal(updateStatus(APP_VERSION), 'current')
  assert.equal(updateStatus('99.0.0'), 'remote-newer')
  assert.equal(updateStatus('0.1.0'), 'remote-older')
})

test('on-demand transcript authorization failure clears an earlier cached snapshot', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  let reads = 0
  const connector = createConnector({ store: h.local, fetchImpl: async (url, options) => {
    if (String(url).includes('/dl/session?') && ++reads === 2) return Response.json({ ok: false, error: 'grant changed' }, { status: 403 })
    return fetch(url, options)
  } })
  await assert.rejects(() => connector.fetchSession(peer, 's1'), /grant changed/)
  assert.throws(() => connector.cachedSession(peer, 's1'), /尚未缓存/)
  assert.equal(connector.cachedView(h.local.state().peers[peer.deviceId]).status, null)
})

test('on-demand transcripts outside the 200-entry directory remain available through sync and offline reads', async t => {
  const h = await archivedHarness(t)
  const peer = await h.pair()
  let archivedReads = 0
  const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async (url, options) => {
    if (String(url).endsWith('/dl/session?id=archived')) archivedReads++
    return fetch(url, options)
  } })
  const fetched = await connector.fetchSession(peer, h.archived.id)
  assert.equal(fetched.session.messages[0].text, 'offline reference text')
  const synced = await connector.sync(peer, true)
  assert.equal(synced.status?.host.sessions.length, 200)
  assert.ok(synced.cachedSessionIds.includes(h.archived.id))
  assert.equal(archivedReads, 2)
  await h.server.stop()
  assert.equal((await connector.fetchSession(peer, h.archived.id)).session.id, h.archived.id)
})

test('directory omissions revalidate cached bodies: network retains, 404 removes, 403 clears the peer', async t => {
  for (const outcome of ['network', 'missing', 'denied'] as const) await t.test(outcome, async t => {
    const h = await archivedHarness(t)
    const peer = await h.pair()
    await h.connector.sync(peer, true)
    await h.local.update(draft => {
      draft.peers[peer.deviceId].cache!.sessions[h.archived.id] = { ...h.archived, cachedAt: '2026-01-01T00:00:00.000Z' }
    })
    let reads = 0
    const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async (url, options) => {
      if (String(url).endsWith('/dl/session?id=archived')) {
        reads++
        if (outcome === 'network') throw new Error('network disconnected')
        return Response.json({ ok: false, error: outcome }, { status: outcome === 'missing' ? 404 : 403 })
      }
      return fetch(url, options)
    } })
    const view = await connector.sync(peer, true)
    assert.equal(reads, 1)
    if (outcome === 'network') {
      assert.equal(connector.cachedSession(peer, h.archived.id).cachedAt, '2026-01-01T00:00:00.000Z')
      assert.equal(view.online, true)
    } else {
      assert.throws(() => connector.cachedSession(peer, h.archived.id), /尚未缓存/)
      assert.equal(view.online, outcome !== 'denied')
      if (outcome === 'denied') assert.equal(h.local.state().peers[peer.deviceId].cache, undefined)
    }
  })
})

test('scope reductions remove directory-omitted bodies before any failing content request', async t => {
  for (const reduced of ['workspaces', 'sessionIds', 'metadata'] as const) await t.test(reduced, async t => {
    const h = await archivedHarness(t)
    const peer = await h.pair()
    await h.connector.sync(peer, true)
    await h.local.update(draft => {
      draft.peers[peer.deviceId].cache!.sessions[h.archived.id] = { ...h.archived, cachedAt: '2026-01-01T00:00:00.000Z' }
    })
    const scope: Scope = { ...defaultScope('same-account'), allowUi: false }
    if (reduced === 'metadata') scope.sessionSync = 'metadata'
    else scope[reduced] = []
    await h.server.setScope(h.local.state().identity.deviceId, scope)
    let reads = 0
    const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async (url, options) => {
      if (String(url).includes('/dl/session?')) { reads++; throw new Error('network disconnected') }
      return fetch(url, options)
    } })
    assert.equal((await connector.sync(peer, true)).online, true)
    assert.equal(reads, 0)
    assert.throws(() => connector.cachedSession(peer, h.archived.id), /尚未缓存/)
  })
})

test('directory-omitted transcript paths are checked using the executing platform', async t => {
  for (const [platform, base, inside, outside] of [
    ['linux', '/srv/shared', '/srv/shared/nested', '/srv/shared-other'],
    ['win32', 'C:\\Shared', 'c:\\shared\\nested', 'C:\\Shared-other'],
  ]) await t.test(platform, async t => {
    const h = await harness(t)
    const peer = await h.pair()
    const status = await h.connector.facts(peer)
    status.host.platform = platform
    status.host.sessions = []
    status.scope = { ...defaultScope('same-account'), allowUi: false, workspaces: [base] }
    let cwd = inside
    const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async url => {
      if (String(url).endsWith('/dl/status')) return Response.json(status)
      return Response.json({ ok: true, session: { ...h.session, id: 'archive', cwd } })
    } })
    assert.equal((await connector.fetchSession(peer, 'archive')).session.cwd, inside)
    cwd = outside
    await assert.rejects(connector.fetchSession(peer, 'archive'))
    assert.equal(h.local.state().peers[peer.deviceId].cache, undefined)
  })
})

test('an on-demand body cannot commit after a concurrent sync observes reduced scope', async t => {
  const h = await archivedHarness(t)
  const peer = await h.pair()
  let signalRead!: () => void
  const reading = new Promise<void>(resolve => { signalRead = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async (url, options) => {
    const response = await fetch(url, options)
    if (String(url).endsWith('/dl/session?id=archived')) { signalRead(); await gate }
    return response
  } })
  const pending = connector.fetchSession(peer, h.archived.id)
  await reading
  await h.server.setScope(h.local.state().identity.deviceId, { ...defaultScope('same-account'), allowUi: false, workspaces: [] })
  await connector.sync(peer, true)
  release()
  await assert.rejects(pending, /授权已变更/)
  assert.throws(() => connector.cachedSession(peer, h.archived.id), /尚未缓存/)
})

test('a late transcript cannot restore tool evidence after a concurrent grant reduction', async t => {
  const h = await archivedHarness(t)
  const peer = await h.pair({ ...defaultScope('same-account'), sessionTools: true })
  h.archived.evidence = [
    { seq: 0, type: 'assistant/message', text: 'public answer', revision: revisionOf('public answer'), truncated: false },
    { seq: 1, type: 'tool/result', text: 'private tool result', revision: revisionOf('private tool result'), truncated: false },
  ]
  let signalRead!: () => void
  const reading = new Promise<void>(resolve => { signalRead = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async (url, options) => {
    const response = await fetch(url, options)
    if (String(url).endsWith('/dl/session?id=archived')) { signalRead(); await gate }
    return response
  } })
  const pending = connector.fetchSession(peer, h.archived.id)
  await reading
  await h.server.setScope(h.local.state().identity.deviceId, { ...defaultScope('same-account'), sessionTools: false })
  await connector.sync(peer, true)
  release()
  assert.deepEqual((await pending).session.evidence.map(event => event.type), ['assistant/message'])
  assert.deepEqual(h.local.state().peers[peer.deviceId].cache!.sessions[h.archived.id].evidence.map(event => event.type), ['assistant/message'])
  await h.server.stop()
  assert.deepEqual(connector.cachedSession(peer, h.archived.id).session.evidence.map(event => event.type), ['assistant/message'])
})

test('incomplete or malformed evidence is rejected before it enters the cache', async t => {
  const h = await harness(t)
  const peer = await h.pair()
  const status = await h.connector.facts(peer)
  const valid = { seq: 0, type: 'assistant/message', text: 'answer', revision: revisionOf('answer'), truncated: false }
  for (const evidence of [undefined, [{ ...valid, seq: -1 }], [{ ...valid, revision: 'not-a-revision' }], [{ ...valid, type: 'request/header' }]]) {
    const connector = createConnector({ store: h.local, log: { warn() {} }, fetchImpl: async url => String(url).endsWith('/dl/status')
      ? Response.json(status) : Response.json({ ok: true, session: { ...h.session, evidence } }) })
    await assert.rejects(() => connector.fetchSession(peer, h.session.id), /invalid session content/)
    assert.equal(h.local.state().peers[peer.deviceId].cache!.sessions[h.session.id], undefined)
  }
})

test('sync replaces invalid cached evidence with an authorized fresh read', async t => {
  const h = await archivedHarness(t)
  const peer = await h.pair()
  await h.connector.sync(peer, true)
  for (const damage of ['missing', 'malformed']) {
    await h.local.update(draft => {
      const cached = { ...h.archived, cachedAt: '2026-01-01T00:00:00.000Z' }
      if (damage === 'missing') Reflect.deleteProperty(cached, 'evidence')
      else cached.evidence = [{ seq: -1, type: 'assistant/message', text: 'invalid', revision: revisionOf('invalid'), truncated: false }]
      draft.peers[peer.deviceId].cache!.sessions[h.archived.id] = cached
    })
    assert.throws(() => h.connector.cachedSession(peer, h.archived.id), { status: 409 })
    const view = await h.connector.sync(peer, true)
    assert.equal(view.online, true)
    const repaired = h.connector.cachedSession(peer, h.archived.id)
    assert.deepEqual(repaired.session.evidence, h.archived.evidence)
    assert.notEqual(repaired.cachedAt, '2026-01-01T00:00:00.000Z')
  }
})
