import { setTimeout as delay } from 'node:timers/promises'
import type { createConnector } from './connect.js'
import { activeTask } from './tasks.js'
import { sameSelection } from './models.js'
import { HttpError, errorMessage, type DeviceTask, type OutgoingTask, type Peer, type Store, type ModelSelection } from './types.js'

export function createOutgoingTasks({ store, connector }: { store: Store; connector: ReturnType<typeof createConnector> }) {
  const pending = new Map<string, Promise<OutgoingTask>>()
  function get(id: string): OutgoingTask {
    const task = store.state().outgoingTasks[id]
    if (!task) throw new HttpError(404, '任务记录不存在')
    return task
  }
  async function saveResult(peer: Peer, id: string, remote?: DeviceTask, cancelled = false): Promise<OutgoingTask> {
    await store.update(draft => {
      const current = draft.outgoingTasks[id]
      if (!current || draft.peers[peer.deviceId]?.token !== peer.token) throw new HttpError(404, '设备连接已变更')
      if (remote && (!current.remote || Date.parse(remote.updatedAt) >= Date.parse(current.remote.updatedAt))) current.remote = remote
      current.submission = cancelled ? 'cancelled' : 'accepted'
      if (cancelled || (current.remote && !activeTask(current.remote))) delete current.cancelRequested
      current.checkedAt = new Date().toISOString()
      delete current.connectionError
    })
    return get(id)
  }
  async function recordFailure(id: string, error: unknown): Promise<OutgoingTask> {
    await store.update(draft => {
      const current = draft.outgoingTasks[id]
      if (!current) return
      current.connectionError = errorMessage(error)
      if (!current.remote && !current.cancelRequested && error instanceof HttpError && error.status >= 400 && error.status < 500) current.submission = 'failed'
    })
    return get(id)
  }
  async function transmit(peer: Peer, task: OutgoingTask): Promise<OutgoingTask> {
    try {
      const remote = await connector.startTask(peer, { requestId: task.id, workspacePath: task.workspacePath, task: task.prompt, sessionId: task.resumeSessionId, selection: task.selection })
      return await saveResult(peer, task.id, remote)
    } catch (error) { return recordFailure(task.id, error) }
  }
  async function start(peer: Peer, input: { id: string; workspacePath: string; task: string; sessionId?: string; originSessionId?: string; originCallId?: string; selection?: ModelSelection }): Promise<OutgoingTask> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id) || !input.task.trim() || input.task.length > 64_000) throw new HttpError(400, '任务标识或内容无效')
    await store.update(draft => {
      if (draft.peers[peer.deviceId]?.token !== peer.token) throw new HttpError(404, '设备连接已变更')
      const existing = draft.outgoingTasks[input.id]
      if (existing) {
        if (!sameSelection(existing.selection, input.selection) || existing.deviceId !== peer.deviceId || existing.workspacePath !== input.workspacePath || existing.prompt !== input.task || existing.resumeSessionId !== input.sessionId) throw new HttpError(409, '任务标识已用于其他请求')
        return
      }
      draft.outgoingTasks[input.id] = {
        id: input.id, deviceId: peer.deviceId, deviceName: peer.name, workspacePath: input.workspacePath,
        prompt: input.task, createdAt: new Date().toISOString(), submission: 'pending',
        resumeSessionId: input.sessionId, originSessionId: input.originSessionId, originCallId: input.originCallId, selection: input.selection,
      }
    })
    const task = get(input.id)
    if (task.remote || task.cancelRequested || task.submission !== 'pending') return task
    return refresh(task.id)
  }
  async function cancel(id: string): Promise<OutgoingTask> {
    const current = get(id)
    if (current.submission === 'cancelled' || current.submission === 'failed' || (current.remote && !activeTask(current.remote))) return current
    await store.update(draft => {
      const task = draft.outgoingTasks[id]
      if (!task) throw new HttpError(404, '任务记录不存在')
      task.cancelRequested = true
    })
    // Let an in-flight submission settle, then cancel the same request identity.
    await pending.get(id)
    return refresh(id)
  }
  async function update(id: string): Promise<OutgoingTask> {
    const task = get(id)
    const peer = store.state().peers[task.deviceId]
    if (!peer) throw new HttpError(404, '设备连接已移除')
    try {
      if (task.cancelRequested && task.submission !== 'cancelled') {
        const result = await connector.cancelTask(peer, id)
        return saveResult(peer, id, result.task, result.cancelled)
      }
      if (task.submission === 'cancelled' || task.submission === 'failed' || (task.remote && !activeTask(task.remote))) return task
      if (task.remote) return await saveResult(peer, id, await connector.readTask(peer, id))
      try { return await saveResult(peer, id, await connector.readTask(peer, id)) } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error
        return transmit(peer, task)
      }
    } catch (error) { return recordFailure(id, error) }
  }
  function refresh(id: string): Promise<OutgoingTask> {
    const existing = pending.get(id)
    if (existing) return existing
    const operation = update(id).finally(() => pending.delete(id))
    pending.set(id, operation)
    return operation
  }
  async function wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<OutgoingTask> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) return cancel(id)
      const task = await refresh(id)
      if (task.submission === 'failed' || task.submission === 'cancelled' || (task.remote && !activeTask(task.remote))) return task
      try { await delay(800, undefined, { signal }) } catch { if (signal?.aborted) return cancel(id) }
    }
    return get(id)
  }
  return { start, get, refresh, cancel, wait,
    list: () => Object.values(store.state().outgoingTasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }
}
