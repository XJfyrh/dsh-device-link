import crypto from 'node:crypto'
import { isPathAllowed } from './scope.js'
import { delegationEnd, delegationText } from './delegation.js'
import type { HostContext } from './host.js'
import { sameSelection } from './models.js'
import {
  HttpError, errorMessage, record, type DelegateInput, type DelegateResult,
  type DeviceTask, type Store, type StoredTask, type TrustedDevice, type ModelSelection,
} from './types.js'

export const activeTask = (task: Pick<DeviceTask, 'status'>) => ['queued', 'running', 'stopping'].includes(task.status)
const taskKey = (owner: string, id: string) => `${owner}:${id}`

export function publicTask(task: StoredTask): DeviceTask {
  const { ownerDeviceId: _owner, tokenHash: _token, baselineSeq: _baseline, resume: _resume, ...view } = task
  return view
}

export async function createTaskManager({ store, ctx, run }: {
  store: Store
  ctx: Pick<HostContext, 'get'>
  run(input: DelegateInput): Promise<DelegateResult>
}) {
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  let disposed = false

  // A saved request is never resubmitted after restart. Reconcile only durable outcomes.
  for (const task of Object.values(store.state().incomingTasks)) {
    if (!activeTask(task)) continue
    let status: DeviceTask['status'] = 'interrupted'
    let text = task.text
    let error = '执行跟进已中断，请查看设备会话确认状态'
    try {
      if (task.baselineSeq !== undefined) {
        const live = ctx.get('sessions')?.get(task.sessionId)
        const events = live?.snapshotEvents() ?? (await ctx.get('sessionQuery')?.readSession(task.sessionId))?.events ?? []
        const end = delegationEnd(events, task.baselineSeq, task.promptRequestId)
        if (end) {
          const reason = record(end.data.reason)
          status = reason.kind === 'completed' ? 'completed' : 'error'
          text = delegationText(events, task.baselineSeq, task.promptRequestId) || text
          error = status === 'error' ? String(record(reason.error).message ?? `turn ended with ${reason.kind}`) : ''
        }
      }
    } catch { /* The retained result remains available when history cannot be read. */ }
    await store.update(draft => {
      const current = draft.incomingTasks[taskKey(task.ownerDeviceId, task.id)]
      if (current) Object.assign(current, { status, text, error: error || undefined, updatedAt: new Date().toISOString() })
    })
  }

  function authorized(task: StoredTask, owner: TrustedDevice): boolean {
    return task.ownerDeviceId === owner.deviceId && task.tokenHash === owner.tokenHash
      && owner.scope.allowDelegate && isPathAllowed(task.workspacePath, owner.scope.workspaces)
  }
  function get(owner: TrustedDevice, id: string): DeviceTask {
    const task = store.state().incomingTasks[taskKey(owner.deviceId, id)]
    if (!task || !authorized(task, owner)) throw new HttpError(404, 'delegated task not found')
    return publicTask(task)
  }

  async function execute(key: string, owner: TrustedDevice, controller: AbortController): Promise<void> {
    const task = store.state().incomingTasks[key]
    try {
      const current = store.state()
      const grant = current.trusted[owner.deviceId]
      if (!current.serve.allowIncoming || !grant || grant.tokenHash !== owner.tokenHash
        || JSON.stringify(grant.scope) !== JSON.stringify(owner.scope)) throw new Error('任务开始前授权已变更')
      const result = await run({
        workspacePath: task.workspacePath, task: task.prompt, sessionId: task.sessionId,
        resume: task.resume, requestId: task.promptRequestId, signal: controller.signal,
        confineWorkspace: owner.scope.workspaces !== 'all',
        selection: task.selection,
        async onProgress(progress) {
          await store.update(draft => {
            const current = draft.incomingTasks[key]
            Object.assign(current, progress, { updatedAt: new Date().toISOString() })
            if (current.status === 'queued') current.status = 'running'
          })
        },
      })
      await store.update(draft => {
        const current = draft.incomingTasks[key]
        current.sessionId = result.sessionId
        current.status = result.cancelled ? 'stopped' : result.status === 'completed' ? 'completed' : 'error'
        current.text = result.text ? result.text.slice(-64_000) : current.text
        current.error = result.cancelled ? undefined : result.error
        current.updatedAt = new Date().toISOString()
      })
    } catch (error) {
      await store.update(draft => {
        Object.assign(draft.incomingTasks[key], { status: 'error', error: errorMessage(error), updatedAt: new Date().toISOString() })
      })
    } finally { running.delete(key) }
  }

  async function submit(owner: TrustedDevice, input: { id: string; workspacePath: string; task: string; sessionId?: string; selection?: ModelSelection }): Promise<DeviceTask> {
    if (disposed) throw new HttpError(503, 'device-link is stopping')
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) throw new HttpError(400, 'invalid task request id')
    if (!input.task.trim() || input.task.length > 64_000) throw new HttpError(400, 'task must contain 1–64000 characters')
    const key = taskKey(owner.deviceId, input.id)
    let created = false
    await store.update(draft => {
      const currentGrant = draft.trusted[owner.deviceId]
      if (!draft.serve.allowIncoming || !currentGrant || currentGrant.tokenHash !== owner.tokenHash
        || JSON.stringify(currentGrant.scope) !== JSON.stringify(owner.scope)) throw new HttpError(403, 'grant changed before task admission')
      if (!currentGrant.scope.allowDelegate || !isPathAllowed(input.workspacePath, currentGrant.scope.workspaces)) throw new HttpError(403, 'task is outside the grant')
      if (draft.taskCancellations[key] === owner.tokenHash) throw new HttpError(409, 'task request was cancelled')
      const existing = draft.incomingTasks[key]
      if (existing) {
        if (!authorized(existing, owner)) throw new HttpError(403, 'task belongs to an earlier authorization')
        if (!sameSelection(existing.selection, input.selection) || existing.workspacePath !== input.workspacePath || existing.prompt !== input.task
          || existing.resume !== !!input.sessionId || (input.sessionId && existing.sessionId !== input.sessionId)) throw new HttpError(409, 'request id already used for another task')
        return
      }
      const active = Object.values(draft.incomingTasks).filter(activeTask)
      if (active.filter(task => task.ownerDeviceId === owner.deviceId).length >= 4) throw new HttpError(429, 'device already has four active tasks')
      if (input.sessionId && active.some(task => task.sessionId === input.sessionId)) throw new HttpError(409, 'session already has an active delegated task')
      const now = new Date().toISOString()
      draft.incomingTasks[key] = {
        id: input.id, ownerDeviceId: owner.deviceId, tokenHash: owner.tokenHash,
        workspacePath: input.workspacePath, prompt: input.task, selection: input.selection,
        sessionId: input.sessionId ?? `delegate-${crypto.randomUUID()}`, resume: !!input.sessionId,
        promptRequestId: `device-link-${crypto.createHash('sha256').update(key).digest('hex')}`,
        status: 'queued', createdAt: now, updatedAt: now, text: '',
      }
      created = true
    })
    if (created) {
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => execute(key, owner, controller))
      running.set(key, { controller, promise })
      void promise.catch(error => console.error('[device-link] task persistence', errorMessage(error)))
    }
    return get(owner, input.id)
  }

  async function stopKey(key: string, reason: string): Promise<void> {
    const active = running.get(key)
    if (!active) return
    let stopping = false
    await store.update(draft => {
      const task = draft.incomingTasks[key]
      if (activeTask(task)) { task.status = 'stopping'; task.updatedAt = new Date().toISOString(); stopping = true }
    })
    if (stopping) active.controller.abort(new Error(reason))
    await active.promise
  }
  async function cancel(owner: TrustedDevice, id: string): Promise<DeviceTask | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'invalid task request id')
    const key = taskKey(owner.deviceId, id)
    await store.update(draft => {
      const grant = draft.trusted[owner.deviceId]
      if (!grant || grant.tokenHash !== owner.tokenHash || !grant.scope.allowDelegate) throw new HttpError(403, 'task authorization unavailable')
      const task = draft.incomingTasks[key]
      if (task && !authorized(task, grant)) throw new HttpError(404, 'delegated task not found')
      draft.taskCancellations[key] = owner.tokenHash
    })
    await stopKey(key, '任务已停止')
    return store.state().incomingTasks[key] ? get(owner, id) : undefined
  }
  async function cancelOwner(ownerId: string): Promise<void> {
    const keys = Object.keys(store.state().incomingTasks).filter(key => key.startsWith(`${ownerId}:`))
    await Promise.all(keys.map(key => stopKey(key, '设备授权已变更')))
  }
  return { submit, get, cancel, cancelOwner,
    async dispose() {
      disposed = true
      await Promise.all([...running.keys()].map(key => stopKey(key, 'device-link stopped')))
    },
  }
}
