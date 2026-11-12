import { normalizeBase, updateStatus } from './network.js'
import { API_VERSION, HttpError, errorMessage, record, type Store, type Logger, type Peer, type RemoteStatus, type SessionContent, type CachedSession, type DeviceTask, type ModelSelection, type ExecutionContext } from './types.js'
import { readableTitle } from './presentation.js'
import path from 'node:path'

function sessionInScope(session: { id: string; cwd: string }, status: RemoteStatus): boolean {
  const scope = status.scope
  const paths = status.host.platform === 'win32' ? path.win32 : path.posix
  if (scope.sessionSync !== 'content' || !paths.isAbsolute(session.cwd)
    || (scope.sessionIds !== 'all' && !scope.sessionIds.includes(session.id))) return false
  return scope.workspaces === 'all' || scope.workspaces.some(base => {
    if (!paths.isAbsolute(base)) return false
    const relative = paths.relative(base, session.cwd)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  })
}

export function createConnector({ store, fetchImpl = globalThis.fetch, log = console }: { store: Store; fetchImpl?: typeof fetch; log?: Logger }) {
  const pending = new Map<string, Promise<PeerView>>()
  const views = new Map<string, { at: number; view: PeerView }>()
  async function request<T>(baseUrl: string, route: string, { token, body, timeoutMs = 4000 }: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const base = normalizeBase(baseUrl)
    const response = await fetchImpl(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.length
          if (length > 2 * 1024 * 1024) throw new HttpError(502, 'device response exceeds 2 MB')
          chunks.push(value)
        }
      } finally { await reader.cancel() }
    }
    let payload: Record<string, unknown>
    try { payload = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { throw new HttpError(502, 'device returned invalid JSON') }
    if (!response.ok || payload.ok !== true) throw new HttpError(response.status >= 400 ? response.status : 502, String(payload.error ?? `HTTP ${response.status}`))
    return payload as T
  }
  async function claim(address: string, code: string): Promise<Peer> {
    if (!/^\d{8}$/.test(code)) throw new HttpError(400, '配对码需要 8 位数字')
    const baseUrl = normalizeBase(address)
    const identity = store.state().identity
    const payload = await request<Record<string, unknown>>(baseUrl, '/dl/pair/claim', { body: { code, deviceId: identity.deviceId, name: identity.name } })
    if (payload.api !== API_VERSION || typeof payload.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(payload.deviceId)
      || ['__proto__', 'constructor', 'prototype'].includes(payload.deviceId) || payload.deviceId === identity.deviceId
      || typeof payload.token !== 'string' || payload.token.length < 32 || typeof payload.name !== 'string') throw new HttpError(502, '对端返回的配对信息无效')
    const now = new Date().toISOString()
    const peer: Peer = { deviceId: payload.deviceId, name: payload.name, baseUrl, token: payload.token, createdAt: now, lastSeenAt: now }
    await store.update(draft => { draft.peers[peer.deviceId] = peer })
    views.delete(peer.deviceId)
    return peer
  }
  async function facts(peer: Peer): Promise<RemoteStatus> {
    const status = await request<RemoteStatus>(peer.baseUrl, '/dl/status', { token: peer.token })
    const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
    const scope = status.scope
    if (status.api !== API_VERSION || status.device?.deviceId !== peer.deviceId || !scope
      || !(scope.workspaces === 'all' || strings(scope.workspaces)) || !(scope.sessionIds === 'all' || strings(scope.sessionIds))
      || typeof scope.allowUi !== 'boolean' || typeof scope.allowDelegate !== 'boolean' || !['none', 'metadata', 'content'].includes(scope.sessionSync)
      || !Array.isArray(status.host?.workspaces) || !status.host.workspaces.every(item => typeof item?.id === 'string' && typeof item.path === 'string')
      || !Array.isArray(status.host.sessions) || !status.host.sessions.every(item => typeof item?.id === 'string' && typeof item.cwd === 'string')
      || !Array.isArray(status.host.agents)) throw new HttpError(502, 'device identity or protocol mismatch')
    return status
  }
  async function readSession(peer: Peer, id: string, status: RemoteStatus, expectedCwd?: string): Promise<SessionContent> {
    const { session } = await request<{ session: SessionContent }>(peer.baseUrl, `/dl/session?id=${encodeURIComponent(id)}`, { token: peer.token })
    if (!session || session.id !== id || typeof session.cwd !== 'string' || !Array.isArray(session.messages)
      || !session.messages.every(message => ['user', 'assistant'].includes(message?.role) && typeof message.text === 'string')
      || (expectedCwd !== undefined && session.cwd !== expectedCwd)) throw new HttpError(502, 'invalid session content')
    if (!sessionInScope(session, status)) throw new HttpError(403, 'session is outside the grant')
    return session
  }
  async function refresh(peer: Peer): Promise<PeerView> {
    try {
      const status = await facts(peer)
      const sessions: Record<string, CachedSession> = Object.create(null) as Record<string, CachedSession>
      if (status.scope.sessionSync === 'content') {
        const previous = store.state().peers[peer.deviceId]?.cache?.sessions ?? {}
        const listed = new Map(status.host.sessions.map(session => [session.id, session]))
        for (const session of Object.values(previous)) {
          const fact = listed.get(session.id)
          if (sessionInScope(session, status) && (!fact || fact.cwd === session.cwd)) sessions[session.id] = session
        }
        // The directory is capped; omitted cached sessions need an authorized read, not eviction.
        const toRead = [...status.host.sessions.slice(0, 20), ...Object.values(sessions).filter(session => !listed.has(session.id))]
        for (const session of toRead) {
          try {
            const content = await readSession(peer, session.id, status, listed.get(session.id)?.cwd)
            sessions[session.id] = { ...content, cachedAt: new Date().toISOString() }
          } catch (error) {
            if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error
            if (error instanceof HttpError && error.status === 404) delete sessions[session.id]
            log.warn?.(`session sync ${session.id}: ${errorMessage(error)}`)
          }
        }
      }
      const syncedAt = new Date().toISOString()
      await store.update(draft => {
        const current = draft.peers[peer.deviceId]
        if (current?.token !== peer.token) return
        current.lastSeenAt = syncedAt
        current.cache = { status, syncedAt, sessions }
      })
      const current = store.state().peers[peer.deviceId]
      if (!current || current.token !== peer.token) throw new HttpError(404, 'device disconnected during sync')
      return viewOf(current, true)
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) {
        await store.update(draft => {
          if (draft.peers[peer.deviceId]?.token === peer.token) delete draft.peers[peer.deviceId].cache
        })
      }
      return viewOf(store.state().peers[peer.deviceId] ?? { ...peer, cache: undefined }, false, errorMessage(error))
    }
  }
  async function sync(peer: Peer, force = false): Promise<PeerView> {
    const cached = views.get(peer.deviceId)
    if (!force && cached && Date.now() - cached.at < 15_000) return cached.view
    const existing = pending.get(peer.deviceId)
    if (existing) return existing
    const operation = refresh(peer).then(view => { views.set(peer.deviceId, { at: Date.now(), view }); return view })
      .finally(() => pending.delete(peer.deviceId))
    pending.set(peer.deviceId, operation)
    return operation
  }
  function cachedView(peer: Peer): PeerView {
    const cached = views.get(peer.deviceId)
    return cached && Date.now() - cached.at < 30_000 ? cached.view : viewOf(peer, false)
  }
  function peerByRef(reference: string): Peer | undefined {
    const wanted = reference.trim().replace(/^@/, '')
    const peers = Object.values(store.state().peers)
    const exact = peers.find(peer => peer.deviceId === wanted || peer.baseUrl === wanted)
    if (exact) return exact
    const named = peers.filter(peer => peer.name.toLowerCase() === wanted.toLowerCase())
    if (named.length > 1) throw new HttpError(400, '设备名重复，请使用设备 id')
    return named[0]
  }
  function cachedSession(peer: Peer, id: string): { session: SessionContent; cachedAt: string; deviceId: string; device: string } {
    const cache = store.state().peers[peer.deviceId]?.cache
    const session = cache && Object.hasOwn(cache.sessions, id) ? cache.sessions[id] : undefined
    if (!cache || !session) throw new HttpError(404, '该会话尚未缓存，先连接设备同步会话内容')
    return { session: { ...session, title: readableTitle(session, session.messages) }, cachedAt: session.cachedAt, deviceId: peer.deviceId, device: peer.name }
  }
  async function fetchSession(peer: Peer, id: string) {
    const view = await sync(peer, true)
    if (!view.online) return cachedSession(peer, id)
    const status = view.status
    if (!status || status.scope.sessionSync !== 'content'
      || (status.scope.sessionIds !== 'all' && !status.scope.sessionIds.includes(id))) throw new HttpError(403, '该会话正文未获授权')
    let session: SessionContent
    try {
      session = await readSession(peer, id, status, status.host.sessions.find(item => item.id === id)?.cwd)
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) {
        await store.update(draft => { if (draft.peers[peer.deviceId]?.token === peer.token) delete draft.peers[peer.deviceId].cache })
        views.delete(peer.deviceId)
      } else if (error instanceof HttpError && error.status === 404) {
        await store.update(draft => {
          const current = draft.peers[peer.deviceId]
          if (current?.token === peer.token && current.cache) delete current.cache.sessions[id]
        })
        views.delete(peer.deviceId)
      }
      throw error
    }
    await store.update(draft => {
      const current = draft.peers[peer.deviceId]
      const currentFact = current?.cache?.status.host.sessions.find(item => item.id === id)
      if (current?.token !== peer.token || !current.cache || !sessionInScope(session, current.cache.status)
        || (currentFact && currentFact.cwd !== session.cwd)) throw new HttpError(403, '会话授权已变更')
      current.cache.sessions[id] = { ...session, cachedAt: new Date().toISOString() }
    })
    views.delete(peer.deviceId)
    return cachedSession(peer, id)
  }
  async function access(peer: Peer) {
    const payload = await request<{ url: string; expiresAt: string }>(peer.baseUrl, '/dl/access', { token: peer.token, body: {} })
    const url = new URL(payload.url)
    if (url.origin !== new URL(normalizeBase(peer.baseUrl)).origin || url.pathname !== '/dl/enter' || !url.searchParams.get('ac')) throw new HttpError(502, 'invalid device access URL')
    return payload
  }
  async function revoke(peer: Peer) {
    let remoteRevoked = true
    try { await request(peer.baseUrl, '/dl/pair/revoke', { token: peer.token, body: { deviceId: store.state().identity.deviceId } }) } catch { remoteRevoked = false }
    await store.update(draft => {
      delete draft.peers[peer.deviceId]
      draft.favorites = draft.favorites.filter(item => item.deviceId !== peer.deviceId)
      for (const [id, task] of Object.entries(draft.outgoingTasks)) if (task.deviceId === peer.deviceId) delete draft.outgoingTasks[id]
    })
    views.delete(peer.deviceId)
    return { remoteRevoked }
  }
  function validateTask(task: DeviceTask, id: string): DeviceTask {
    if (!task || task.id !== id || typeof task.sessionId !== 'string' || typeof task.workspacePath !== 'string'
      || typeof task.prompt !== 'string' || typeof task.text !== 'string' || typeof task.updatedAt !== 'string'
      || !['queued', 'running', 'stopping', 'completed', 'error', 'stopped', 'interrupted'].includes(task.status)) throw new HttpError(502, 'invalid delegated task response')
    return task
  }
  return { claim, facts, sync, cachedView, peerByRef, cachedSession, fetchSession, access, revoke,
    async execution(peer: Peer, workspacePath: string, sessionId?: string) {
      return request<ExecutionContext>(peer.baseUrl, '/dl/execution', { token: peer.token, body: { workspacePath, sessionId }, timeoutMs: 15_000 })
    },
    async startTask(peer: Peer, input: { requestId: string; workspacePath: string; task: string; sessionId?: string; selection?: ModelSelection }) {
      const response = await request<{ task: DeviceTask }>(peer.baseUrl, '/dl/tasks', { token: peer.token, body: input, timeoutMs: 10_000 })
      return validateTask(response.task, input.requestId)
    },
    async readTask(peer: Peer, id: string) {
      const response = await request<{ task: DeviceTask }>(peer.baseUrl, `/dl/tasks/${encodeURIComponent(id)}`, { token: peer.token })
      return validateTask(response.task, id)
    },
    async cancelTask(peer: Peer, id: string) {
      const response = await request<{ task?: DeviceTask; cancelled: boolean }>(peer.baseUrl, `/dl/tasks/${encodeURIComponent(id)}/cancel`, { token: peer.token, body: {}, timeoutMs: 15_000 })
      return { task: response.task ? validateTask(response.task, id) : undefined, cancelled: response.cancelled === true }
    },
  }
}

export interface PeerView {
  deviceId: string
  name: string
  baseUrl: string
  online: boolean
  lastSeenAt: string
  cachedAt: string | null
  cachedSessionIds: string[]
  status: RemoteStatus | null
  update: ReturnType<typeof updateStatus>
  probeError: string | null
}
function viewOf(peer: Peer, online: boolean, error?: string): PeerView {
  const status = peer.cache?.status
  return { deviceId: peer.deviceId, name: peer.name, baseUrl: peer.baseUrl, online, lastSeenAt: peer.lastSeenAt,
    cachedAt: peer.cache?.syncedAt ?? null, cachedSessionIds: Object.keys(peer.cache?.sessions ?? {}), status: status ? { ...status, host: { ...status.host,
      sessions: status.host.sessions.map(session => ({ ...session, title: readableTitle(session, peer.cache?.sessions[session.id]?.messages) })) } } : null,
    update: peer.cache ? updateStatus(peer.cache.status.device.version) : 'unknown', probeError: error ?? null }
}
