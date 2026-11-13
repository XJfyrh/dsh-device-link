import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LoadRuntime, Runtime } from '../index.js'
import type { HostContext } from './host.js'
import { readJson, sendJson } from './http.js'
import { diagnose } from './network.js'
import { defaultScope, normalizeScope } from './scope.js'
import { parseSelection } from './models.js'
import { HttpError, errorMessage, type AccountRelation } from './types.js'
import type { ResourceRequest } from './resources.js'
import { renameDevice } from './identity.js'

export async function statePayload(runtime: Runtime) {
  const { server, connector, store, hostFacts } = runtime
  const peers = await Promise.all(Object.values(store.state().peers).map(peer => connector.sync(peer)))
  return { ok: true as const, ...server.info(), identity: store.state().identity, pairing: server.pairingCode(),
    addresses: server.addresses(), host: await hostFacts(), peers, trusted: server.trusted(), favorites: store.state().favorites }
}
export type DeviceState = Awaited<ReturnType<typeof statePayload>>

export function registerDeviceApi(ctx: HostContext, { load }: { load: LoadRuntime }): () => void {
  async function handle(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
    const { server, connector, store, outgoingTasks, references } = runtime
    const route = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/device-link/api/'.length)
    if (req.method === 'GET' && route === 'state') { sendJson(res, 200, await statePayload(runtime)); return }
    if (req.method === 'GET' && route === 'references') {
      sendJson(res, 200, { ok: true, peers: Object.values(store.state().peers).map(peer => connector.cachedView(peer)) })
      return
    }
    if (req.method === 'GET' && route === 'tasks') {
      sendJson(res, 200, { ok: true, tasks: outgoingTasks.list() }); return
    }
    if (req.method !== 'POST') throw new HttpError(404, 'unknown device-link endpoint')
    const body = await readJson(req)
    let result: unknown
    switch (route) {
      case 'rename': result = { identity: await renameDevice(store, body.name) }; break
      case 'reference-prepare': result = { descriptor: await references.prepare(String(body.deviceId ?? ''), { workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined, sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined }) }; break
      case 'reference-detail': result = references.get(String(body.referenceId ?? ''), typeof body.localSessionId === 'string' ? body.localSessionId : undefined); break
      case 'reference-call': result = { call: references.call(String(body.localSessionId ?? ''), String(body.callId ?? '')) }; break
      case 'reference-preview': result = { result: await references.query(String(body.referenceId ?? ''), body as Partial<ResourceRequest>) }; break
      case 'task-refresh': result = { task: await outgoingTasks.refresh(String(body.id ?? '')) }; break
      case 'task-cancel': result = { task: await outgoingTasks.cancel(String(body.id ?? '')) }; break
      case 'allow': {
        const relationship = String(body.relationship ?? 'unknown') as AccountRelation
        result = server.openPairing({ relationship, scope: body.scope ? normalizeScope(body.scope) : defaultScope(relationship) })
        break
      }
      case 'close-pairing': server.closePairing(); result = {}; break
      case 'pair': {
        const peer = await connector.claim(String(body.address ?? ''), String(body.code ?? ''))
        result = { peer: { deviceId: peer.deviceId, name: peer.name, baseUrl: peer.baseUrl } }
        break
      }
      case 'diagnose': result = { diagnostic: await diagnose(body.address) }; break
      case 'toggle':
        if (typeof body.allowIncoming !== 'boolean') throw new HttpError(400, 'allowIncoming must be boolean')
        await server.setIncoming(body.allowIncoming)
        result = { allowIncoming: server.info().allowIncoming }
        break
      case 'scope': result = { scope: await server.setScope(String(body.deviceId ?? ''), body.scope) }; break
      case 'revoke': {
        if (body.side === 'trusted') { result = { revoked: await server.revoke(String(body.deviceId ?? '')) }; break }
        const peer = connector.peerByRef(String(body.deviceId ?? ''))
        if (!peer) throw new HttpError(404, '没有这个设备')
        result = await connector.revoke(peer)
        await references.removePeer(peer.deviceId)
        break
      }
      default: {
        const peer = connector.peerByRef(String(body.deviceId ?? ''))
        if (!peer) throw new HttpError(404, '没有这个设备')
        if (route === 'open') result = await connector.access(peer)
        else if (route === 'execution') result = await connector.execution(peer, String(body.workspacePath ?? ''), typeof body.sessionId === 'string' ? body.sessionId : undefined)
        else if (route === 'task-start') result = { task: await outgoingTasks.start(peer, {
          id: String(body.id ?? ''), workspacePath: String(body.workspacePath ?? ''), task: String(body.task ?? ''),
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          selection: parseSelection(body.selection),
          originSessionId: typeof body.originSessionId === 'string' ? body.originSessionId : undefined,
        }) }
        else if (route === 'favorite') {
          const path = String(body.path ?? '')
          const workspace = peer.cache?.status.host.workspaces.find(item => item.path === path)
          if (body.enabled !== false && !workspace) throw new HttpError(404, '工作区尚未同步或已移除授权')
          await store.update(draft => {
            if (draft.peers[peer.deviceId]?.token !== peer.token) throw new HttpError(404, '设备连接已变更')
            draft.favorites = draft.favorites.filter(item => item.deviceId !== peer.deviceId || item.path !== path)
            if (body.enabled !== false && workspace) draft.favorites.push({ deviceId: peer.deviceId, path, title: workspace.title })
          })
          result = { favorites: store.state().favorites }
        }
        else if (route === 'sync') result = { peer: await connector.sync(peer, true) }
        else if (route === 'session') result = body.refresh === true
          ? await connector.fetchSession(peer, String(body.sessionId ?? ''))
          : connector.cachedSession(peer, String(body.sessionId ?? ''))
        else throw new HttpError(404, 'unknown device-link endpoint')
      }
    }
    sendJson(res, 200, { ok: true, ...result as object })
  }
  return ctx.webServer.register({ kind: 'prefix', path: '/device-link', async handler(req, res) {
    let rejection: number | undefined
    try { rejection = ctx.connection.requestRejection({ headers: req.headers }) } catch { rejection = 403 }
    if (rejection) { req.resume(); sendJson(res, rejection, { ok: false, error: 'owner authentication required' }); return }
    try { await handle(req, res, await load()) } catch (error) {
      if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: errorMessage(error) })
      else res.destroy()
    }
  } })
}
