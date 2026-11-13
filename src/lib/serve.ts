import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import crypto from 'node:crypto'
import { createDeviceToken, verifyToken, type createPairing } from './pairing.js'
import { lanAddresses } from './config.js'
import { readJson, sendJson } from './http.js'
import { authorizedWorkspace, defaultScope, normalizeScope, sessionAllowed, isPathAllowed } from './scope.js'
import { normalizeDeviceName } from './identity.js'
import type { createTaskManager } from './tasks.js'
import { parseSelection } from './models.js'
import type { ExecutionContext } from './types.js'
import type { ResourceRequest, ResourceResult } from './resources.js'
import { API_VERSION, APP_VERSION, HttpError, errorMessage, type Store, type Scope, type Logger, type PairingGrant, type HostFacts, type SessionContent, type TrustedDevice } from './types.js'

export interface GuiProxy {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> | void
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}
interface ServerConfig { port?: number; bindAddress?: string; allowIncoming?: boolean; accessTtlMs?: number; maxPairFailures?: number; failureWindowMs?: number }
interface ServerDependencies {
  config: ServerConfig
  store: Store
  pairing: ReturnType<typeof createPairing>
  proxy: GuiProxy
  factsProvider?: (scope: Scope) => Promise<HostFacts>
  sessionProvider?: (id: string, scope: Scope) => Promise<SessionContent>
  taskManager?: Awaited<ReturnType<typeof createTaskManager>>
  executionProvider?: (workspace: string, sessionId?: string) => Promise<ExecutionContext>
  resourceProvider?: (input: ResourceRequest, scope: Scope) => Promise<ResourceResult>
  log?: Logger
}

export function createDeviceLinkServer({ config, store, pairing, proxy, factsProvider, sessionProvider, taskManager, executionProvider, resourceProvider, log = console }: ServerDependencies) {
  let listen: { host: string; port: number } | null = null
  let activePairing: (PairingGrant & { code: string; expiresAt: string }) | null = null
  const accessCodes = new Map<string, { token: string; deviceId: string; expiresAt: number }>()
  const failures = new Map<string, { count: number; resetAt: number }>()
  const sockets = new Set<Duplex>()
  const authorizedSockets = new Map<Duplex, Set<string>>()
  const incomingAllowed = () => config.allowIncoming !== false && store.state().serve.allowIncoming

  function authenticate(req: IncomingMessage): { entry: TrustedDevice; token: string } {
    if (!incomingAllowed()) throw new HttpError(403, 'incoming connections are disabled', 'disabled')
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]
      ?? req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('dl_session='))?.slice(11)
    const entry = token && Object.values(store.state().trusted).find(device => device.active && verifyToken(token, device.tokenHash))
    if (!entry || !token) throw new HttpError(401, 'unauthorized', 'unauthorized')
    return { entry, token }
  }
  function requireUi(entry: TrustedDevice): void {
    const scope = entry.scope
    if (!scope.allowUi || scope.workspaces !== 'all' || scope.sessionSync !== 'content' || scope.sessionIds !== 'all') {
      throw new HttpError(403, 'full UI access is outside the grant', 'scope')
    }
  }
  function checkOrigin(req: IncomingMessage): void {
    if (req.headers.origin && req.headers.origin !== origin()) throw new HttpError(403, 'foreign origin denied', 'origin')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request denied', 'origin')
  }
  function origin(): string {
    if (!listen) throw new HttpError(503, 'listener unavailable')
    return `http://${listen.host}:${listen.port}`
  }
  function trackSocket(socket: Duplex, deviceId: string): void {
    const ids = authorizedSockets.get(socket) ?? new Set<string>()
    ids.add(deviceId)
    authorizedSockets.set(socket, ids)
  }
  async function closeDevice(deviceId: string): Promise<void> {
    for (const [socket, ids] of authorizedSockets) if (ids.has(deviceId)) socket.destroy()
    for (const [code, access] of accessCodes) if (access.deviceId === deviceId) accessCodes.delete(code)
    await taskManager?.cancelOwner(deviceId)
  }
  async function collect(entry: TrustedDevice): Promise<HostFacts> {
    if (!factsProvider) throw new HttpError(503, 'host facts unavailable')
    const facts = await factsProvider(entry.scope)
    // Re-check after asynchronous host reads and enforce filtering at the wire boundary.
    const current = store.state().trusted[entry.deviceId]
    if (!incomingAllowed() || !current || current.tokenHash !== entry.tokenHash || JSON.stringify(current.scope) !== JSON.stringify(entry.scope)) throw new HttpError(403, 'grant changed during read')
    return { ...facts, workspaces: facts.workspaces.filter(workspace => isPathAllowed(workspace.path, entry.scope.workspaces)),
      sessions: facts.sessions.filter(session => sessionAllowed(session, entry.scope)),
      agents: facts.agents.filter(agent => sessionAllowed(agent, entry.scope)) }
  }
  async function claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!incomingAllowed()) throw new HttpError(403, 'incoming connections are disabled')
    const key = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    for (const [address, failure] of failures) if (failure.resetAt <= now) failures.delete(address)
    const failure = failures.get(key) ?? { count: 0, resetAt: now + (config.failureWindowMs ?? 600_000) }
    if (failure.count >= (config.maxPairFailures ?? 8)) throw new HttpError(429, 'too many pairing attempts', 'rate_limited')
    const body = await readJson(req)
    if (typeof body.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(body.deviceId) || ['__proto__', 'constructor', 'prototype'].includes(body.deviceId)) throw new HttpError(400, 'invalid deviceId')
    if (body.deviceId === store.state().identity.deviceId) throw new HttpError(400, 'cannot pair a device with itself')
    const name = normalizeDeviceName(body.name)
    if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) throw new HttpError(400, '8-digit code required')
    const grant = activePairing
    const result = pairing.consume(body.code, key)
    if (!result.ok || !grant) {
      failure.count++
      failures.set(key, failure)
      const reason = result.ok ? 'mismatch' : result.reason
      throw new HttpError(reason === 'expired' ? 410 : reason === 'attempts' ? 429 : 403, `pairing ${reason}`, reason)
    }
    activePairing = null
    failures.delete(key)
    const { token, tokenHash } = createDeviceToken()
    const deviceId = body.deviceId
    const createdAt = new Date().toISOString()
    await closeDevice(deviceId)
    await store.update(draft => {
      draft.trusted[deviceId] = { deviceId, name,
        createdAt, lastSeenAt: createdAt, active: true, tokenHash, relationship: grant.relationship, scope: grant.scope }
    })
    sendJson(res, 200, { ok: true, api: API_VERSION, ...store.state().identity, token, scope: grant.scope, relationship: grant.relationship })
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin())
    const route = url.pathname
    checkOrigin(req)
    if (req.method === 'GET' && route === '/dl/info') {
      sendJson(res, 200, { ok: true, api: API_VERSION, app: 'dsh-device-link', version: APP_VERSION, ...info() })
      return
    }
    if (req.method === 'POST' && route === '/dl/pair/claim') return claim(req, res)
    if (req.method === 'GET' && route === '/dl/enter') {
      const code = url.searchParams.get('ac') ?? ''
      const access = accessCodes.get(code)
      accessCodes.delete(code)
      if (!access || access.expiresAt <= Date.now()) throw new HttpError(401, 'access code invalid or expired')
      const entry = store.state().trusted[access.deviceId]
      if (!incomingAllowed() || !entry || !verifyToken(access.token, entry.tokenHash)) throw new HttpError(401, 'access revoked')
      requireUi(entry)
      res.writeHead(302, { location: '/', 'set-cookie': `dl_session=${access.token}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end()
      return
    }
    const { entry, token } = authenticate(req)
    if (req.method === 'POST' && route === '/dl/pair/revoke') {
      const body = await readJson(req)
      if (body.deviceId !== entry.deviceId) throw new HttpError(403, 'a device may only revoke itself')
      await revoke(entry.deviceId)
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && route === '/dl/status') {
      const encodedName = req.headers['x-device-link-name']
      if (encodedName !== undefined) {
        let name: string
        try { name = normalizeDeviceName(decodeURIComponent(String(encodedName))) } catch { throw new HttpError(400, '设备名称无效') }
        if (name !== entry.name) await store.update(draft => {
          const current = draft.trusted[entry.deviceId]
          if (!incomingAllowed() || !current?.active || current.tokenHash !== entry.tokenHash) throw new HttpError(403, 'grant changed during sync')
          current.name = name
        })
      }
      const host = await collect(entry)
      sendJson(res, 200, { ok: true, api: API_VERSION, device: { ...store.state().identity, app: 'dsh-device-link', version: APP_VERSION }, scope: entry.scope, host })
      return
    }
    if (req.method === 'GET' && route === '/dl/session') {
      if (!sessionProvider) throw new HttpError(503, 'session content unavailable')
      const content = await sessionProvider(url.searchParams.get('id') ?? '', entry.scope)
      await collect(entry)
      if (entry.scope.sessionSync !== 'content' || !sessionAllowed(content, entry.scope)) throw new HttpError(403, 'session is outside the grant')
      sendJson(res, 200, { ok: true, session: content })
      return
    }
    if (req.method === 'POST' && route === '/dl/resource') {
      if (!resourceProvider) throw new HttpError(503, 'resource service unavailable')
      const input = await readJson(req) as unknown as ResourceRequest
      const result = await resourceProvider(input, entry.scope)
      const current = store.state().trusted[entry.deviceId]
      if (!incomingAllowed() || !current?.active || current.tokenHash !== entry.tokenHash || JSON.stringify(current.scope) !== JSON.stringify(entry.scope)) throw new HttpError(403, 'grant changed during read', 'scope')
      sendJson(res, 200, { ok: true, result }); return
    }
    if (req.method === 'POST' && route === '/dl/access') {
      requireUi(entry)
      for (const [code, access] of accessCodes) if (access.expiresAt <= Date.now()) accessCodes.delete(code)
      if (accessCodes.size >= 1000) throw new HttpError(429, 'too many pending access codes')
      const ac = crypto.randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + (config.accessTtlMs ?? 60_000)
      accessCodes.set(ac, { deviceId: entry.deviceId, token, expiresAt })
      sendJson(res, 200, { ok: true, url: `${origin()}/dl/enter?ac=${ac}`, expiresAt: new Date(expiresAt).toISOString() })
      return
    }
    if ((route === '/dl/tasks' || route === '/dl/execution') && req.method === 'POST') {
      if (!taskManager) throw new HttpError(503, 'task service unavailable')
      if (!entry.scope.allowDelegate) throw new HttpError(403, 'delegation disabled', 'scope')
      const body = await readJson(req)
      if (typeof body.workspacePath !== 'string' || (route === '/dl/tasks' && typeof body.task !== 'string')) throw new HttpError(400, 'workspacePath and task required')
      const workspacePath = await authorizedWorkspace(body.workspacePath, entry.scope)
      await collect(entry)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      if (sessionId) {
        const owned = Object.values(store.state().incomingTasks).some(task => task.ownerDeviceId === entry.deviceId
          && task.tokenHash === entry.tokenHash && task.sessionId === sessionId && task.workspacePath === workspacePath)
        if (!owned) {
          if (entry.scope.sessionSync !== 'content' || !sessionAllowed({ id: sessionId, cwd: workspacePath }, entry.scope)) throw new HttpError(403, '此会话未授权继续，请在执行设备开放该会话正文或新建任务', 'scope')
          if (!sessionProvider) throw new HttpError(503, 'session service unavailable')
          const session = await sessionProvider(sessionId, entry.scope)
          if (session.cwd !== workspacePath) throw new HttpError(403, 'session workspace does not match')
          await collect(entry)
        }
      }
      if (route === '/dl/execution') {
        if (!executionProvider) throw new HttpError(503, '执行设备未提供模型目录')
        const context = await executionProvider(workspacePath, sessionId)
        await collect(entry)
        sendJson(res, 200, { ok: true, ...context })
        return
      }
      const task = await taskManager.submit(entry, { id: String(body.requestId ?? ''), workspacePath, task: String(body.task), sessionId, selection: parseSelection(body.selection) })
      sendJson(res, 200, { ok: true, task })
      return
    }
    const taskRoute = /^\/dl\/tasks\/([a-zA-Z0-9_-]{1,128})(\/cancel)?$/.exec(route)
    if (taskRoute) {
      if (!taskManager) throw new HttpError(503, 'task service unavailable')
      await collect(entry)
      if (req.method === 'POST' && taskRoute[2]) {
        await readJson(req)
        const task = await taskManager.cancel(entry, taskRoute[1])
        await collect(entry)
        sendJson(res, 200, { ok: true, task, cancelled: !task || task.status === 'stopped' })
      } else if (req.method === 'GET' && !taskRoute[2]) {
        sendJson(res, 200, { ok: true, task: taskManager.get(entry, taskRoute[1]) })
      } else throw new HttpError(404, 'unknown task endpoint')
      return
    }
    if (route.startsWith('/dl/')) throw new HttpError(404, 'unknown device endpoint')
    requireUi(entry)
    trackSocket(req.socket, entry.deviceId)
    await proxy.handle(req, res)
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: errorMessage(error), reason: error instanceof HttpError ? error.reason : 'internal' })
      else res.destroy()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); authorizedSockets.delete(socket) })
  })
  server.on('upgrade', (req, socket, head) => {
    try {
      checkOrigin(req)
      const { entry } = authenticate(req)
      requireUi(entry)
      trackSocket(socket, entry.deviceId)
      proxy.handleUpgrade(req, socket, head)
    } catch { socket.destroy() }
  })
  server.on('error', error => log.warn?.(errorMessage(error)))
  function listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen(port, config.bindAddress)
    })
  }
  async function start() {
    if (listen) return listen
    if (!config.bindAddress || !net.isIPv4(config.bindAddress) || config.bindAddress === '0.0.0.0') throw new Error('bindAddress must be one concrete local IPv4 literal')
    try { await listenOn(config.port ?? 47654) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      log.warn?.(`port ${config.port} already in use, falling back to an OS-assigned port`)
      await listenOn(0)
    }
    const address = server.address() as net.AddressInfo
    listen = { host: address.address, port: address.port }
    return listen
  }
  async function stop(): Promise<void> {
    closePairing()
    await Promise.all(Object.keys(store.state().trusted).map(id => closeDevice(id)))
    accessCodes.clear()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    listen = null
  }
  function info() {
    const state = store.state()
    return { deviceId: state.identity.deviceId, name: state.identity.name, pairingOpen: pairing.isOpen() && incomingAllowed(), allowIncoming: incomingAllowed(), trustedCount: Object.keys(state.trusted).length, listen }
  }
  function openPairing(grant: PairingGrant = { relationship: 'unknown', scope: defaultScope('unknown') }) {
    if (!incomingAllowed()) throw new HttpError(403, 'incoming connections are disabled')
    if (!['same-account', 'different-account', 'unknown'].includes(grant.relationship)) throw new HttpError(400, 'invalid relationship')
    const scope = normalizeScope(grant.scope)
    failures.clear()
    activePairing = { ...pairing.openPairing(), relationship: grant.relationship, scope }
    return { ...activePairing, port: listen?.port ?? config.port, addresses: addresses().map(address => ({ address })) }
  }
  function closePairing(): void { activePairing = null; pairing.closePairing() }
  function addresses(): string[] { return listen ? [listen.host] : [] }
  async function revoke(deviceId: string): Promise<boolean> {
    if (!store.state().trusted[deviceId]) return false
    await store.update(draft => { delete draft.trusted[deviceId] })
    await closeDevice(deviceId)
    return true
  }
  async function setScope(deviceId: string, value: unknown): Promise<Scope> {
    const scope = normalizeScope(value)
    await store.update(draft => {
      if (!draft.trusted[deviceId]) throw new HttpError(404, 'trusted device not found')
      draft.trusted[deviceId].scope = scope
    })
    await closeDevice(deviceId)
    return scope
  }
  async function setIncoming(allowed: boolean): Promise<void> {
    await store.update(draft => { draft.serve.allowIncoming = allowed })
    if (!allowed) {
      closePairing()
      await Promise.all(Object.keys(store.state().trusted).map(id => closeDevice(id)))
    }
  }
  return { start, stop, info, openPairing, closePairing, pairingCode: () => pairing.isOpen() ? activePairing : null,
    addresses, interfaces: lanAddresses, revoke, setScope, setIncoming,
    trusted: () => Object.values(store.state().trusted).map(({ tokenHash: _secret, ...entry }) => entry) }
}
