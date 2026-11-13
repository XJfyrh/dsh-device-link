import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { createConnector } from './connect.js'
import { sessionInScope } from './connect.js'
import { HttpError, type Store, type Peer } from './types.js'
import { revisionOf } from './evidence.js'
import type { ResourceRequest, ResourceResult, ResourceTarget } from './resources.js'

export interface ReferenceDescriptor extends ResourceTarget {
  id: string; deviceId: string; device: string; title: string; referenceCreatedAt: string
  sessionUpdatedAt?: number
  availability: 'online' | 'cached' | 'unavailable'; cachedAt?: string
  capabilities: string[]
}
export interface ReadReceipt {
  id: string; localSessionId: string; callId: string; createdAt: string
  action: ResourceRequest['action']; query?: string; result: ResourceResult
}
type ReferenceIdentity = Omit<ReferenceDescriptor, 'availability' | 'cachedAt' | 'capabilities'>
interface StoredReference { descriptor: ReferenceIdentity; credential: string; receipts: ReadReceipt[] }
export async function createReferences({ store, connector }: { store: Store; connector: ReturnType<typeof createConnector> }) {
  const filename = path.join(store.directory, 'references.json')
  let entries: Record<string, StoredReference> = {}
  try { entries = JSON.parse(await fs.readFile(filename, 'utf8')) as typeof entries }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let tail = Promise.resolve()
  function update(mutate: (draft: typeof entries) => void) {
    const task = tail.then(async () => {
      const next = structuredClone(entries); mutate(next)
      const temporary = `${filename}.${randomUUID()}.tmp`
      try { await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await fs.rename(temporary, filename); entries = next }
      finally { await fs.rm(temporary, { force: true }) }
    })
    tail = task.catch(() => {}); return task
  }
  function authorized(id: string) {
    const entry = Object.hasOwn(entries, id) ? entries[id] : undefined
    if (!entry) throw new HttpError(404, '引用已移除，请重新添加')
    const d = entry.descriptor
    const peer = store.state().peers[d.deviceId]
    if (!peer || revisionOf(peer.token) !== entry.credential || !peer.cache) throw new HttpError(403, '引用的设备连接或授权已移除')
    const status = peer.cache.status
    if (d.kind === 'session' && !sessionInScope({ id: d.sessionId!, cwd: d.workspacePath }, status)) throw new HttpError(403, '会话授权已变更')
    if (d.kind === 'workspace' && !status.host.workspaces.some(workspace => workspace.path === d.workspacePath)) throw new HttpError(403, '工作区授权已变更')
    return { entry, peer }
  }
  function describe(d: ReferenceIdentity, peer: Peer): ReferenceDescriptor {
    const cached = d.sessionId ? peer.cache?.sessions[d.sessionId] : undefined
    const scope = peer.cache!.status.scope
    return { id: d.id, deviceId: d.deviceId, device: peer.name, title: d.title, referenceCreatedAt: d.referenceCreatedAt,
      ...(cached ? { sessionUpdatedAt: cached.updatedAt } : {}),
      kind: d.kind, workspacePath: d.workspacePath, ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      availability: connector.cachedView(peer).online ? 'online' : cached ? 'cached' : 'unavailable',
      ...(cached ? { cachedAt: cached.cachedAt } : {}),
      capabilities: d.kind === 'session' ? ['搜索对话文本', '读取事件原文', ...(scope.sessionTools ? ['读取工具调用与结果'] : [])]
        : [...(scope.allowReadFiles ? ['搜索当前文件', '按行读取文本文件'] : []), ...(scope.allowDelegate ? ['另行委派任务到此工作区'] : [])] }
  }
  function resultAllowed(d: ReferenceIdentity, peer: Peer, result: ResourceResult): boolean {
    const scope = peer.cache!.status.scope
    return (d.kind !== 'workspace' || scope.allowReadFiles === true)
      && (scope.sessionTools === true || !result.items.some(item => item.type?.startsWith('tool/')))
  }
  async function prepare(deviceId: string, target: { workspacePath?: string; sessionId?: string }) {
    const peer = connector.peerByRef(deviceId)
    if (!peer?.cache) throw new HttpError(404, '设备资源尚未同步')
    const session = target.sessionId ? peer.cache.sessions[target.sessionId] ?? peer.cache.status.host.sessions.find(session => session.id === target.sessionId) : undefined
    const workspace = peer.cache.status.host.workspaces.find(item => item.path === target.workspacePath)
    if (target.sessionId ? !session : !workspace) throw new HttpError(404, '找不到引用的资源')
    const descriptor: ReferenceIdentity = { id: randomUUID(), deviceId: peer.deviceId, device: peer.name,
      kind: session ? 'session' : 'workspace', workspacePath: session?.cwd ?? workspace!.path, ...(session ? { sessionId: session.id } : {}),
      title: session?.title ?? workspace!.title, referenceCreatedAt: new Date().toISOString() }
    const entry = { descriptor, credential: revisionOf(peer.token), receipts: [] }
    if (session && !sessionInScope(session, peer.cache.status)) throw new HttpError(403, '会话正文未授权')
    await update(draft => {
      if (store.state().peers[peer.deviceId]?.token !== peer.token) throw new HttpError(403, '设备连接已变更')
      draft[descriptor.id] = entry
    })
    return describe(descriptor, authorized(descriptor.id).peer)
  }
  async function query(id: string, options: Partial<ResourceRequest>, execution?: { localSessionId: string; callId: string }) {
    const { entry, peer } = authorized(id)
    const d = entry.descriptor
    if (d.kind === 'workspace' && !peer.cache?.status.scope.allowReadFiles) throw new HttpError(403, '设备未授权文件读取')
    const input: ResourceRequest = { action: options.action ?? 'inspect', kind: d.kind, workspacePath: d.workspacePath, sessionId: d.sessionId,
      query: options.query, path: options.path, seq: options.seq, revision: options.revision, startLine: options.startLine, offset: options.offset }
    const result = await connector.resource(peer, input)
    function checkResult() {
      const { peer: current } = authorized(id)
      if (!resultAllowed(d, current, result)) throw new HttpError(403, '读取授权已变更')
    }
    checkResult()
    if (execution) await update(draft => {
      checkResult()
      const receipts = draft[id].receipts
      const receipt: ReadReceipt = { id: randomUUID(), ...execution, createdAt: new Date().toISOString(), action: input.action, query: input.query, result: structuredClone(result) }
      receipts.push(receipt)
      // A bounded local audit is separate from the Host's durable tool history.
      if (receipts.length > 80) receipts.splice(0, receipts.length - 80)
    })
    return { referenceId: id, device: d.device, resource: d.title, ...result }
  }
  return { prepare, query,
    call(localSessionId: string, callId: string) {
      for (const [id, value] of Object.entries(entries)) {
        const receipt = value.receipts.find(item => item.localSessionId === localSessionId && item.callId === callId)
        if (!receipt) continue
        try {
          const { peer } = authorized(id)
          if (resultAllowed(value.descriptor, peer, receipt.result)) return { descriptor: describe(value.descriptor, peer), receipt: structuredClone(receipt) }
        }
        catch { continue }
      }
      return null
    },
    get(id: string, localSessionId?: string) {
      const { entry, peer } = authorized(id)
      const d = entry.descriptor
      return { descriptor: describe(d, peer), receipts: structuredClone(entry.receipts.filter(receipt => receipt.localSessionId === localSessionId && resultAllowed(d, peer, receipt.result))) }
    },
    async removePeer(deviceId: string) { await update(draft => { for (const [id, value] of Object.entries(draft)) if (value.descriptor.deviceId === deviceId) delete draft[id] }) },
  }
}
