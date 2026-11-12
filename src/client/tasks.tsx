import type * as ReactTypes from 'react'
import type { ClientPrimitives, CreatePortal } from './contracts.js'
import { api, active, draftKey, message, type ClientState, type Resource, type SessionSnapshot } from './state.js'
import type { ExecutionContext, OutgoingTask } from '../lib/types.js'
import { relativeTime, shortText, workspaceName } from '../lib/presentation.js'
import { conversationTurns, statusLabels } from './conversation.js'
import { createModelPicker } from './model-picker.js'

export function createTaskComponents(React: typeof ReactTypes, state: ClientState, Markdown: ReactTypes.ComponentType<{ text: string }>, primitives: ClientPrimitives, createPortal: CreatePortal) {
  const { useState, useEffect, useRef, useSyncExternalStore } = React
  const { IconCopyOutlineRegular: CopyIcon, IconCheckOutlineRegular: CheckIcon, IconChevronRightOutlineRegular: ChevronIcon, IconFolderCloseRegular: FolderIcon } = primitives
  const useView = () => useSyncExternalStore(state.subscribe, state.getSnapshot)
  function CopyMessage({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer) } }, [copied])
    return <button type="button" className="dl-icon-button" aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => state.notify('复制失败，请选择消息文字复制'))
    }}>{copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}</button>
  }
  function TaskCard({ task, source = 'tasks' }: { task: OutgoingTask; source?: 'tasks' | 'local' }) {
    return <article className="dl dl-task" data-task-id={task.id}>
      <button className="dl-task-link" onClick={() => state.openTask(task, source)}>
        <span className="row between"><strong className="ellipsis">{shortText(task.prompt)}</strong><span className="task-state">{statusLabels[task.remote?.status ?? task.submission]}</span></span>
        <small className="dl-meta"><span>{task.deviceName} › {workspaceName(task.workspacePath)}</span><span>{relativeTime(task.remote?.updatedAt ?? task.createdAt)}</span></small>
        <p className="dl-excerpt">{shortText(task.remote?.text || task.remote?.error || task.connectionError || '打开任务查看进展', 140)}</p>
        <span className="dl-link">查看任务 ›</span>
      </button>
    </article>
  }
  const ModelPicker = createModelPicker(React, primitives, createPortal)
  function Detail({ resource }: { resource: Resource }) {
    const view = useView()
    const peer = state.peer(resource.deviceId)
    const selectedTask = view.tasks.find(task => task.id === resource.taskId)
    const sessionId = selectedTask?.remote?.sessionId ?? resource.sessionId
    const actual = { ...resource, sessionId }
    const tasks = view.tasks.filter(task => task.deviceId === resource.deviceId && (task.id === resource.taskId || (!!sessionId && (task.remote?.sessionId ?? task.resumeSessionId) === sessionId)))
    const running = tasks.find(active)
    const draft = view.drafts[draftKey(resource)] ?? { text: '' }
    const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
    const [context, setContext] = useState<ExecutionContext | null>(null)
    const [contextError, setContextError] = useState('')
    const [historyError, setHistoryError] = useState('')
    const [error, setError] = useState('')
    const [sending, setSending] = useState(false)
    const [loading, setLoading] = useState(false)
    const [refresh, setRefresh] = useState(0)
    const scroller = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const anchored = useRef('')
    const restoreScroll = useRef(state.scroll(resource))
    const input = useRef<HTMLTextAreaElement>(null)
    useEffect(() => {
      const node = input.current
      if (node) { node.style.height = '0px'; node.style.height = `${Math.min(240, Math.max(36, node.scrollHeight))}px` }
    }, [draft.text])
    const hasContent = peer?.status?.scope.sessionSync === 'content'
    const canDelegate = !!peer?.status?.scope.allowDelegate
    const terminalRevision = tasks.map(task => `${task.id}:${task.remote?.status ?? task.submission}`).join('|')
    useEffect(() => {
      if (!sessionId || sessionId === resource.sessionId) return
      const old = state.getSnapshot().drafts[draftKey(resource)]
      if (old) state.setDraft(actual, old)
      state.change({ execution: actual })
    }, [sessionId])
    useEffect(() => {
      if (!peer?.online || !canDelegate || !resource.workspace) { setContext(null); return }
      let stopped = false
      const controller = new AbortController()
      async function load() {
        try {
          const next = await api<ExecutionContext>('execution', { deviceId: resource.deviceId, workspacePath: resource.workspace, sessionId }, controller.signal)
          if (!stopped) { setContext(next); setContextError('') }
        } catch (cause) { if (!stopped) { setContext(null); setContextError(message(cause)) } }
      }
      void load()
      const timer = setInterval(() => void load(), 10_000)
      return () => { stopped = true; controller.abort(); clearInterval(timer) }
    }, [resource.deviceId, resource.workspace, sessionId, peer?.online, canDelegate, terminalRevision, refresh])
    useEffect(() => {
      if (!sessionId) return
      const controller = new AbortController()
      if (!hasContent && !peer?.cachedSessionIds.includes(sessionId)) { setSnapshot(null); setHistoryError(''); return }
      setLoading(true)
      api<SessionSnapshot>('session', { deviceId: resource.deviceId, sessionId, refresh: !!peer?.online && hasContent }, controller.signal)
        .then(value => { setSnapshot(value); setHistoryError('') })
        .catch(cause => { if (!controller.signal.aborted) setHistoryError(message(cause)) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
      return () => controller.abort()
    }, [sessionId, peer?.online, hasContent, terminalRevision, refresh])
    const turns = conversationTurns(tasks, snapshot)
    const latestTask = tasks[0]
    const selection = draft.selection ?? context?.selected
    const validModel = !!context?.catalog.groups.some(group => group.id === selection?.provider && group.models.some(model => model.id === selection.model
      && (!selection.reasoningEffort || model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort))))
    const busy = !!running || !!context?.busy
    const sessionTitle = snapshot?.session.title ?? peer?.status?.host.sessions.find(session => session.id === sessionId)?.title
      ?? (tasks.length ? shortText([...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].prompt) : sessionId ? resource.title : '新建任务')
    const target = view.returnTarget
    useEffect(() => {
      const container = scroller.current
      if (!container) return
      if (restoreScroll.current !== undefined && turns.length) {
        container.scrollTop = restoreScroll.current
        restoreScroll.current = undefined
        anchored.current = resource.taskId ?? ''
        stick.current = false
        return
      }
      if (resource.taskId && anchored.current !== resource.taskId) {
        const element = container.querySelector<HTMLElement>(`[data-turn-task="${resource.taskId}"]`)
        if (element) { container.scrollTop = element.offsetTop - container.offsetTop - 16; anchored.current = resource.taskId; stick.current = false }
      } else if (stick.current) container.scrollTop = container.scrollHeight
    }, [resource.taskId, terminalRevision, snapshot, tasks.map(task => task.remote?.text.length ?? 0).join('|')])
    async function submit() {
      if (!resource.workspace || !draft.text.trim() || sending || busy || !peer?.online || !canDelegate || !selection || !validModel) return
      setSending(true); setError('')
      const text = draft.text.trim()
      try {
        const task = await state.submitTask(actual, { text, selection })
        if (task.submission === 'failed') {
          setError(task.connectionError ?? '任务未被接收')
          if (!state.getSnapshot().drafts[draftKey(resource)]?.text) state.setDraft(resource, {text,selection})
        }
        stick.current = true; anchored.current = task.id
        input.current?.focus()
      } catch (cause) { setError(message(cause)) } finally { setSending(false) }
    }
    async function stop(task: OutgoingTask) {
      try { await state.cancelTask(task.id) } catch (cause) { setError(message(cause)) }
    }
    function turnStatus(task: OutgoingTask) {
      return <div className="dl-turn-status" role="status"><span>{statusLabels[task.remote?.status ?? task.submission]}</span>
        {task.cancelRequested && active(task) && <span>，正在等待执行设备确认停止</span>}
        {task.connectionError && <p>{task.remote ? '暂时无法更新状态，执行设备上的任务可能仍在运行。' : task.submission === 'pending' ? '尚未确认送达，恢复连接后会核对同一次提交。' : task.connectionError}</p>}
        {task.remote?.error && <p className="error">{task.remote.error}</p>}
        {(task.connectionError || task.remote?.status === 'interrupted') && <button onClick={() => void state.refreshTask(task.id).catch(cause => setError(message(cause)))}>检查状态</button>}
        {(task.submission === 'failed' || ['error', 'stopped', 'interrupted'].includes(task.remote?.status ?? '')) && <button onClick={() => { state.setDraft(resource, { text: task.prompt, selection: task.selection }); input.current?.focus() }}>重新编辑</button>}
      </div>
    }
    const sendLabel = sending ? '提交中…' : busy ? '等待当前任务结束' : sessionId ? '发送' : '开始任务'
    return <main className="dl dl-conversation">
      <header className="dl-conversation-header">
        <button className="dl-icon-button dl-back" onClick={state.back} aria-label={target?.source === 'workspace' ? '返回工作区' : target?.source === 'local' ? '返回本地会话' : '设备任务'} title={target?.source === 'workspace' ? '返回工作区' : target?.source === 'local' ? '返回本地会话' : '设备任务'}><ChevronIcon size={16} /></button>
        <h2 className="ellipsis" title={sessionTitle}>{shortText(sessionTitle, 65)}</h2>
        <span className="dl-remote-source ellipsis" title={`${peer?.name ?? selectedTask?.deviceName ?? '连接已移除'} › ${workspaceName(resource.workspace)}`}><span className="dl-source-part"><span className="dl-device-icon" aria-hidden="true" />{peer?.name ?? selectedTask?.deviceName ?? '连接已移除'}</span><ChevronIcon size={12} /><span className="dl-source-part"><FolderIcon size={14} />{workspaceName(resource.workspace)}</span></span>
        <span className="status"><i className={`dot ${peer?.online ? 'online' : ''}`} />{peer?.online ? '在线' : '离线'}</span>
        <details className="dl-context-details"><summary aria-label="任务信息" title="任务信息">信息</summary><div>
          <p>设备：{peer?.name ?? selectedTask?.deviceName ?? '执行设备'}</p><p>工作区：{workspaceName(resource.workspace)}</p><p className="path">{resource.workspace}</p>
          <small>任务与浏览器会话在 {peer?.name ?? '执行设备'} 上运行</small>
          {snapshot && <small>{peer?.online ? '会话同步于' : '正文缓存于'} {relativeTime(snapshot.cachedAt)}</small>}
          {sessionId && <small className="path">会话标识：{sessionId}</small>}
          {target?.source !== 'tasks' && <button onClick={() => state.change({ execution: null })}>全部任务</button>}
        </div></details>
      </header>
      <div className="dl-transcript" ref={scroller} onScroll={() => { const node = scroller.current; if (node) { stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; state.saveScroll(resource, node.scrollTop) } }}>
        <div className="dl-transcript-content">
          {!peer?.online && <p className="dl-notice">设备离线，已收到的内容仍可阅读。恢复连接后可继续发送。</p>}
          {sessionId && !hasContent && <p className="dl-notice">会话正文未获同步授权，这里显示从本机委派的任务和返回结果。</p>}
          {snapshot?.session.truncated && <p className="dl-notice">较早的会话内容已截断。</p>}
          {historyError && <p className="dl-notice">{historyError} <button onClick={() => setRefresh(value => value + 1)}>重新读取</button></p>}
          {loading && !turns.length && <p className="muted" role="status">正在读取会话…</p>}
          {!turns.length && !loading && !historyError && <div className="dl-start"><h2>{sessionId ? hasContent ? '会话还没有消息' : '尚无本机任务结果' : `在 ${workspaceName(resource.workspace)} 中开始任务`}</h2><p className="muted">{sessionId ? hasContent ? '在下方输入，继续这段对话。' : '查看完整历史需要执行设备授权同步此会话正文。' : `描述要完成的工作，任务将在 ${peer?.name ?? '此设备'} 上执行。`}</p></div>}
          {turns.map(turn => <section className="dl-turn" key={turn.key} data-turn-task={turn.task?.id}>
            {turn.messages.map((item, index) => <React.Fragment key={item.seq ?? `${turn.key}-${index}`}>
              {turn.task && index === turn.messages.findIndex(message => message.role === 'assistant') && turnStatus(turn.task)}
              <div className={`dl-chat-message ${item.role}`}>
              {item.role === 'user' ? <div className="dl-user-bubble">{item.text}</div> : <Markdown text={item.text} />}
              <div className="dl-message-actions"><CopyMessage text={item.text} />
                {item.timestamp && <time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}
              </div></div>
            </React.Fragment>)}
            {turn.task && !turn.messages.some(message => message.role === 'assistant') && turnStatus(turn.task)}
          </section>)}
        </div>
      </div>
      <div className="dl-compose-area"><form className="dl-chat-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
        {resource.taskId && latestTask && latestTask.id !== resource.taskId && <small>正在查看较早任务，发送后将接续此会话的最新上下文。</small>}
        <textarea ref={input} rows={1} aria-label="设备任务内容" placeholder={busy ? '可先写好下一条要求，当前任务结束后发送' : '发消息或创建任务'} value={draft.text} onChange={event => state.setDraft(resource, { ...draft, text: event.target.value })} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit() }
        }} />
        <div className="dl-composer-toolbar"><small className="dl-execution-target ellipsis" title={resource.workspace}>在 {peer?.name ?? '执行设备'} 上执行</small><div className="dl-composer-trailing">{context && selection ? <ModelPicker context={context} selected={selection} disabled={sending || busy} onChange={selection => state.setDraft(resource, { ...draft, selection })} />
          : <small>{contextError || (peer?.online ? canDelegate ? '正在读取执行模型…' : '此设备未授权委派任务' : '连接恢复后可选择模型')}</small>}
          {running ? <button className="dl-send" type="button" aria-label="停止任务" title="停止任务" disabled={running.cancelRequested} onClick={() => void stop(running)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg></button>
            : <button className="dl-send" type="submit" aria-label={sendLabel} title={sendLabel} disabled={sending || busy || !peer?.online || !canDelegate || !validModel || !draft.text.trim()}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" /></svg></button>}
        </div></div>
        {contextError && <button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取模型</button>}
        {context && selection && !validModel && <p className="error">所选模型或思考强度已不可用，请重新选择。</p>}
        {context?.catalog.failures.length ? <small>{context.catalog.failures.map(item => item.name).join('、')} 的模型目录暂不可用</small> : null}
        {error && <p className="error" role="alert">{error}</p>}
      </form><small className="dl-draft-note">{draft.text ? '草稿已保存。Enter 发送，Shift + Enter 换行' : '\u00a0'}</small></div>
    </main>
  }
  function TasksPage() {
    const view = useView()
    const [query, setQuery] = useState('')
    if (view.execution) return <Detail key={`${view.execution.deviceId}:${view.execution.sessionId ?? view.execution.workspace}`} resource={view.execution} />
    const tasks = view.tasks.filter(task => `${task.prompt} ${task.deviceName} ${task.workspacePath}`.toLowerCase().includes(query.toLowerCase()))
    const attention = (task: OutgoingTask) => task.submission === 'failed' || !!task.connectionError || ['error', 'interrupted'].includes(task.remote?.status ?? '')
    const groups = [['需要处理', tasks.filter(attention)], ['进行中', tasks.filter(task => active(task) && !attention(task))], ['最近任务', tasks.filter(task => !active(task) && !attention(task))]] as const
    return <main className="dl dl-tasks"><div><header className="row between"><h2>设备任务</h2><button className="primary" onClick={() => state.change({ panel: 'all' })}>新建任务</button></header>
      {view.error && <p className="error" role="alert">{view.error}</p>}
      {!!view.tasks.length && <input className="dl-task-search" aria-label="搜索任务" placeholder="搜索任务、设备或工作区" value={query} onChange={event => setQuery(event.target.value)} />}
      {groups.map(([label, items]) => items.length ? <section className="dl-task-group" key={label}><h3>{label} <small>{items.length}</small></h3>{items.map(task => <TaskCard task={task} key={task.id} />)}</section> : null)}
      {!tasks.length && <div className="empty"><p>{query ? '没有匹配的任务' : '还没有设备任务'}</p>{!query && <p className="muted">选择设备上的工作区，开始第一项任务。</p>}</div>}
    </div></main>
  }
  return { TaskCard, TasksPage }
}
