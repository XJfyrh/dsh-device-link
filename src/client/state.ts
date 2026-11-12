import type { DeviceState } from '../lib/api.js'
import type { PeerView } from '../lib/connect.js'
import type { OutgoingTask, SessionContent, ModelSelection } from '../lib/types.js'
import type { ClientContext, Reference } from './contracts.js'

export const SOURCE = '设备工作区与缓存会话'
export interface SessionSnapshot { session: SessionContent; cachedAt: string; device: string; deviceId: string }
export interface Resource { deviceId: string; workspace?: string; sessionId?: string; title: string; snapshot?: SessionSnapshot; taskId?: string }
export interface Draft { text: string; selection?: ModelSelection }
export const draftKey = (resource: Resource) => JSON.stringify([resource.deviceId, resource.sessionId ? 'session' : 'workspace', resource.sessionId ?? resource.workspace])
export interface ReturnTarget { source: 'workspace' | 'tasks' | 'local'; resource?: Resource; localSessionId?: string; rightExpanded?: boolean }
export type PanelRoute = 'list' | 'all' | 'pair' | 'host' | 'settings' | string
export interface ViewState {
  data: DeviceState | null
  tasks: OutgoingTask[]
  error: string
  panel: PanelRoute | null
  preview: Resource | null
  execution: Resource | null
  toast: string
  drafts: Record<string, Draft>
  returnTarget?: ReturnTarget
}
export class ApiError extends Error { constructor(public status: number, text: string) { super(text) } }
export async function api<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/device-link/api/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const payload = await response.json() as T & { ok?: boolean; error?: string }
  if (!response.ok || payload.ok === false) throw new ApiError(response.status, payload.error ?? `HTTP ${response.status}`)
  return payload
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function requestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function active(task: OutgoingTask): boolean {
  return task.remote ? ['queued', 'running', 'stopping'].includes(task.remote.status) : task.submission === 'pending'
}
export function reference(resource: Resource): Reference {
  const ref = resource.sessionId
    ? `device://${resource.deviceId}/session?id=${encodeURIComponent(resource.sessionId)}`
    : `device://${resource.deviceId}/workspace?path=${encodeURIComponent(resource.workspace ?? '')}`
  return { source: SOURCE, ref, label: resource.title, appearance: resource.sessionId ? 'session' : 'folder', clipboardText: `@${ref}` }
}
export function parseReference(ref: string): Resource {
  const url = new URL(ref)
  if (url.protocol !== 'device:' || !['/session', '/workspace'].includes(url.pathname)) throw new Error('设备引用无效')
  return { deviceId: url.hostname, sessionId: url.searchParams.get('id') ?? undefined, workspace: url.searchParams.get('path') ?? undefined, title: '设备资源' }
}
export function resourceAddress(resource: Resource): string {
  return `dsh-resource://device-link/view?ref=${encodeURIComponent(reference(resource).ref)}&title=${encodeURIComponent(resource.title)}`
}
export function parseAddress(address: string): Resource {
  const url = new URL(address)
  return { ...parseReference(url.searchParams.get('ref') ?? ''), title: url.searchParams.get('title') ?? '设备资源' }
}
export async function serializeReference(ref: string, signal: AbortSignal): Promise<string> {
  const resource = parseReference(ref)
  let data: SentReferenceData
  if (resource.sessionId) {
    const snapshot = await api<SessionSnapshot>('session', { deviceId: resource.deviceId, sessionId: resource.sessionId }, signal)
    data = { ref, label: `${snapshot.device} › ${snapshot.session.title}`, source: '设备会话缓存，正文作为历史资料', snapshot }
  } else {
    const { peers } = await api<{ peers: PeerView[] }>('references', undefined, signal)
    const peer = peers.find(peer => peer.deviceId === resource.deviceId)
    const workspace = peer?.status?.host.workspaces.find(workspace => workspace.path === resource.workspace)
    if (!peer || !workspace) throw new Error('设备工作区已移除或未获授权，请重新选择')
    data = { ref, label: `${peer.name} › ${workspace.title}`, source: '设备工作区', deviceId: peer.deviceId, workspacePath: workspace.path }
  }
  const label = data.label.replace(/\s+/g, ' ').slice(0, 200)
  return `引用 ${label}\n<device-link-reference>\n${JSON.stringify(data).replaceAll('<', '\\u003c')}\n</device-link-reference>`
}

export interface SentReferenceData { ref: string; label: string; source: string; snapshot?: SessionSnapshot; deviceId?: string; workspacePath?: string }
export const sentReferenceRule = {
  id: 'device-link-reference', order: 10,
  match(text: string, from: number) {
    const pattern = /(?:引用 [^\r\n]+\n)?<device-link-reference>\n([^\n]+)\n<\/device-link-reference>/g
    pattern.lastIndex = from
    for (const match of text.matchAll(pattern)) {
      try {
        const data = JSON.parse(match[1]) as SentReferenceData
        parseReference(data.ref)
        if (typeof data.label !== 'string') continue
        if (data.snapshot) {
          const snapshot = data.snapshot
          const session = snapshot.session
          if (typeof snapshot.device !== 'string' || typeof snapshot.cachedAt !== 'string' || !session
            || typeof session.id !== 'string' || typeof session.cwd !== 'string' || typeof session.title !== 'string'
            || !Array.isArray(session.messages) || !session.messages.every(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string')) continue
        }
        return { id: 'device-link-reference', start: match.index, end: match.index + match[0].length, data }
      } catch { /* Leave malformed reference text visible in the conversation. */ }
    }
    return undefined
  },
}

export function createClientState(ctx: ClientContext) {
  let view: ViewState = { data: null, tasks: [], error: '', panel: null, preview: null, execution: null, toast: '', drafts: {} }
  let storageKey = ''
  let scrolls: Record<string, number> = {}
  let localTasks: Record<string, OutgoingTask> = {}
  const submissions = new Map<string, Promise<OutgoingTask>>()
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const controller = new AbortController()
  let pending: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  function persist() {
    if (!storageKey) return
    try { window.localStorage.setItem(storageKey, JSON.stringify({ drafts: view.drafts, execution: view.execution, returnTarget: view.returnTarget, scrolls, localTasks })) }
    catch { notify('浏览器无法保存草稿，请保持此页面打开') }
  }
  function change(next: Partial<ViewState>) {
    view = { ...view, ...next }
    if ('drafts' in next || 'execution' in next || 'returnTarget' in next) persist()
    for (const listener of listeners) listener()
  }
  function notify(text: string) {
    change({ toast: text }); clearTimeout(toastTimer)
    toastTimer = setTimeout(() => change({ toast: '' }), 5000)
  }
  function refresh(): Promise<void> {
    return pending ??= Promise.all([api<DeviceState>('state', undefined, controller.signal), api<{ tasks: OutgoingTask[] }>('tasks', undefined, controller.signal)])
      .then(([data, result]) => {
        if (controller.signal.aborted) return
        if (!storageKey) {
          storageKey = `device-link-0.4:${data.identity.deviceId}`
          try {
            const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Partial<ViewState> & { scrolls?: Record<string, number>; localTasks?: Record<string, OutgoingTask> }
            if (saved.localTasks) localTasks = Object.fromEntries(Object.entries(saved.localTasks).filter(([id, task]) => task && task.id === id && typeof task.prompt === 'string' && typeof task.deviceId === 'string'))
            if (saved.scrolls) scrolls = Object.fromEntries(Object.entries(saved.scrolls).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))
            if (saved.drafts && typeof saved.drafts === 'object') view.drafts = Object.fromEntries(Object.entries(saved.drafts).filter(([, draft]) => draft && typeof draft.text === 'string'))
            if (saved.execution && typeof saved.execution.deviceId === 'string' && typeof saved.execution.title === 'string') view.execution = saved.execution
            if (saved.returnTarget && ['workspace', 'tasks', 'local'].includes(saved.returnTarget.source)) view.returnTarget = saved.returnTarget
          } catch { /* A damaged local draft never prevents loading device data. */ }
        }
        for (const task of result.tasks) {
          if (localTasks[task.id]?.cancelRequested && active(task)) task.cancelRequested = true
          else delete localTasks[task.id]
        }
        const remoteIds = new Set(result.tasks.map(task => task.id))
        change({ data, tasks: [...result.tasks, ...Object.values(localTasks).filter(task => !remoteIds.has(task.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), error: '' })
        persist()
      })
      .catch(error => { if (!controller.signal.aborted) change({ error: message(error) }) })
      .finally(() => { pending = undefined })
  }
  async function poll() {
    await refresh()
    if (controller.signal.aborted) return
    await Promise.allSettled(view.tasks.filter(task => active(task) || task.cancelRequested).map(task => localTasks[task.id] ? sendLocal(task.id) : refreshTask(task.id)))
    if (!controller.signal.aborted) timer = setTimeout(() => void poll(), view.tasks.some(active) ? 2500 : 10_000)
  }
  function putTask(task: OutgoingTask) {
    change({ tasks: [task, ...view.tasks.filter(item => item.id !== task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
  }
  function sendLocal(id: string): Promise<OutgoingTask> {
    const existing = submissions.get(id)
    if (existing) return existing
    const task = localTasks[id]
    if (!task) return refreshTask(id)
    const operation = api<{ task: OutgoingTask }>('task-start', { id, deviceId: task.deviceId, workspacePath: task.workspacePath, task: task.prompt,
      sessionId: task.resumeSessionId, originSessionId: task.originSessionId, selection: task.selection })
      .then(async result => {
        if (localTasks[id]?.cancelRequested) result = await api<{ task: OutgoingTask }>('task-cancel', { id })
        const confirmed = view.tasks.find(task => task.id === id)
        if (confirmed?.remote && (!result.task.remote || Date.parse(confirmed.remote.updatedAt) > Date.parse(result.task.remote.updatedAt))) result = { task: confirmed }
        delete localTasks[id]; persist(); putTask(result.task); return result.task
      })
      .catch(cause => {
        // Polling may confirm delivery before this older submission loses its response.
        const confirmed = !localTasks[id] && view.tasks.find(task => task.id === id)
        if (confirmed) return confirmed
        const failed = { ...task, connectionError: message(cause), submission: cause instanceof ApiError && cause.status >= 400 && cause.status < 500 ? 'failed' as const : 'pending' as const }
        localTasks[id] = failed; persist(); putTask(failed); return failed
      }).finally(() => submissions.delete(id))
    submissions.set(id, operation)
    return operation
  }
  async function submitTask(resource: Resource, draft: Draft): Promise<OutgoingTask> {
    const task: OutgoingTask = { id: requestId(), deviceId: resource.deviceId, deviceName: view.data?.peers.find(peer => peer.deviceId === resource.deviceId)?.name ?? '执行设备',
      workspacePath: resource.workspace!, prompt: draft.text.trim(), selection: draft.selection, resumeSessionId: resource.sessionId,
      originSessionId: view.returnTarget?.localSessionId, createdAt: new Date().toISOString(), submission: 'pending' }
    localTasks[task.id] = task
    change({ execution: { ...resource, taskId: task.id } })
    putTask(task)
    setDraft(resource, { ...draft, text: '' })
    return sendLocal(task.id)
  }
  async function refreshTask(id: string) { const result = await api<{ task: OutgoingTask }>('task-refresh', { id }, controller.signal); putTask(result.task); return result.task }
  async function cancelTask(id: string) {
    if (localTasks[id]) { localTasks[id].cancelRequested = true; persist(); putTask(localTasks[id]); return sendLocal(id) }
    const result = await api<{ task: OutgoingTask }>('task-cancel', { id }, controller.signal); putTask(result.task); return result.task
  }
  function preview(resource: Resource) {
    change({ panel: null })
    if (!resource.snapshot && ctx.sidebarRight.mounted.getSnapshot()) {
      ctx.layout.selectPanel(null)
      ctx.sidebarRight.openResource(resourceAddress(resource))
    } else change({ preview: resource })
  }
  function quote(resource: Resource, sessionId?: string) {
    const target = sessionId ?? ctx.sidebarRight.mounted.getSnapshot()
    if (!target) throw new Error('先打开或新建一个本地会话，再引用此资源')
    const scope = ctx.sessions.scope(target)
    if (!scope) throw new Error('本地会话已关闭，请重新打开后引用')
    const input = ctx.conversation.input.for(scope)
    const draft = input.state.getSnapshot()
    const peerName = view.data?.peers.find(peer => peer.deviceId === resource.deviceId)?.name
    const label = peerName && !resource.title.startsWith(`${peerName} › `) ? `${peerName} › ${resource.title}` : resource.title
    if (!input.insertReference(reference({ ...resource, title: label }), { start: draft.draft.length, end: draft.draft.length, draftRev: draft.draftRev })) throw new Error('输入内容已变化，请重新引用')
    ctx.uiWorkspace.openSession(target)
    change({ panel: null, preview: null })
    if (window.innerWidth < 850 && ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
    input.focus()
    notify('已加入本地输入框')
  }
  function execute(resource: Resource, target?: ReturnTarget) {
    const rightExpanded = ctx.sidebarRight.isExpanded()
    change({ execution: resource, panel: null, preview: null, returnTarget: { ...(target ?? { source: 'workspace', resource: { deviceId: resource.deviceId, workspace: resource.workspace, title: resource.workspace?.split(/[\\/]/).at(-1) ?? '工作区' }, localSessionId: ctx.sidebarRight.mounted.getSnapshot() }), rightExpanded } })
    if (rightExpanded) ctx.sidebarRight.toggleExpanded()
    ctx.layout.selectPanel('device-link-tasks')
  }
  function openTask(task: OutgoingTask, source: 'tasks' | 'local' = 'tasks') {
    delete scrolls[draftKey({ deviceId: task.deviceId, sessionId: task.remote?.sessionId ?? task.resumeSessionId, workspace: task.workspacePath, title: task.prompt })]
    execute({ deviceId: task.deviceId, workspace: task.workspacePath, sessionId: task.remote?.sessionId ?? task.resumeSessionId, title: task.prompt, taskId: task.id },
      { source, localSessionId: task.originSessionId ?? ctx.sidebarRight.mounted.getSnapshot() })
  }
  function back() {
    const target = view.returnTarget
    change({ execution: null })
    if (target?.source === 'tasks') return
    if (target?.localSessionId) ctx.uiWorkspace.openSession(target.localSessionId)
    ctx.layout.selectPanel(null)
    if (target?.source === 'workspace' && target.resource) preview(target.resource)
    else if (target?.rightExpanded && !ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
  }
  function setDraft(resource: Resource, draft: Draft) { change({ drafts: { ...view.drafts, [draftKey(resource)]: draft } }) }
  return { getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    change, notify, refresh, preview, quote, execute, refreshTask, cancelTask, putTask, openTask, back, setDraft, submitTask,
    scroll(resource: Resource): number | undefined { return scrolls[draftKey(resource)] },
    saveScroll(resource: Resource, top: number) { scrolls[draftKey(resource)] = top; clearTimeout(scrollTimer); scrollTimer = setTimeout(persist, 250) },
    peer(id: string): PeerView | undefined { return view.data?.peers.find(peer => peer.deviceId === id) },
    start() { void poll(); return () => { persist(); controller.abort(); clearTimeout(timer); clearTimeout(toastTimer); clearTimeout(scrollTimer) } },
  }
}
export type ClientState = ReturnType<typeof createClientState>
