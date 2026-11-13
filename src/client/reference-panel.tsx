import type * as ReactTypes from 'react'
import { api, message, type ClientState, type Resource } from './state.js'
import type { ClientPrimitives } from './contracts.js'
import type { ReadReceipt, ReferenceDescriptor } from '../lib/references.js'
import type { ResourceItem, ResourceRequest, ResourceResult } from '../lib/resources.js'
import { statusLabels } from './conversation.js'

interface Page { result: ResourceResult; receipt?: ReadReceipt; query?: string; directory?: string }

export function createReferencePanel(React: typeof ReactTypes, state: ClientState, primitives: ClientPrimitives) {
  const { useEffect, useRef, useState } = React
  return function ReferencePanel({ resource, sessionId }: { resource: Resource; sessionId?: string }) {
    const [descriptor, setDescriptor] = useState<ReferenceDescriptor>()
    const [page, setPage] = useState<Page>()
    const [history, setHistory] = useState<Page[]>([])
    const [query, setQuery] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(true)
    const [showScope, setShowScope] = useState(false)
    const [selection, setSelection] = useState<{ text: string; item: ResourceItem }>()
    const pending = useRef<AbortController | undefined>(undefined)
    const body = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const controller = new AbortController()
      pending.current?.abort(); pending.current = controller
      setDescriptor(undefined); setPage(undefined); setHistory([]); setError(''); setSelection(undefined); setQuery(''); setShowScope(false); setBusy(true)
      async function load() {
        const detail = await api<{ descriptor: ReferenceDescriptor; receipts: ReadReceipt[] }>('reference-detail', {
          referenceId: resource.referenceId, localSessionId: resource.sourceSessionId ?? sessionId ?? state.currentSession(),
        }, controller.signal)
        if (controller.signal.aborted) return
        setDescriptor(detail.descriptor)
        if (resource.receiptId) {
          const receipt = detail.receipts.find(item => item.id === resource.receiptId)
          if (!receipt) throw new Error('这次读取记录已不可用')
          setPage({ result: receipt.result, receipt, query: receipt.query })
        } else {
          if (detail.descriptor.kind === 'workspace' && !detail.descriptor.capabilities.includes('搜索当前文件')) throw new Error('文件读取未获授权，请在设备上调整连接授权。')
          const response = await api<{ result: ResourceResult }>('reference-preview', { referenceId: resource.referenceId, action: 'inspect' }, controller.signal)
          if (!controller.signal.aborted) setPage({ result: response.result, directory: '' })
        }
      }
      void load().catch(error => { if (!controller.signal.aborted) setError(message(error)) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
      return () => { controller.abort(); pending.current?.abort() }
    }, [resource.referenceId, resource.receiptId, resource.sourceSessionId, sessionId])
    useEffect(() => { body.current?.scrollTo({ top: 0 }); setShowScope(false); setSelection(undefined) }, [page])
    async function preview(action: ResourceRequest['action'], item?: ResourceItem, next = false) {
      pending.current?.abort()
      const controller = new AbortController(); pending.current = controller
      setBusy(true); setError(''); setSelection(undefined)
      try {
        const directory = action === 'inspect' ? item?.path ?? '' : action === 'search' ? page?.directory ?? '' : undefined
        const response = await api<{ result: ResourceResult }>('reference-preview', { referenceId: resource.referenceId, action, query,
          path: action === 'read' ? item?.path : directory, seq: item?.seq, revision: item?.revision,
          startLine: next ? item?.nextLine : 1, offset: next ? item?.nextOffset : 0 }, controller.signal)
        if (controller.signal.aborted) return
        if (page) setHistory(previous => [...previous, page])
        setPage({ result: response.result, directory, query: action === 'search' ? query.trim() : undefined })
      } catch (error) { if (!controller.signal.aborted) setError(message(error)) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    function back() {
      pending.current?.abort(); setBusy(false); setError('')
      setPage(history.at(-1)); setHistory(previous => previous.slice(0, -1))
    }
    function quote() {
      if (!page || !selection) return
      const { text, item } = selection
      try { state.quote({ ...resource, title: descriptor?.title ?? resource.title, referenceId: undefined, receiptId: undefined, sourceSessionId: undefined,
        excerpt: { text, seq: item.seq, path: item.path, revision: item.revision, cachedAt: page.result.observedAt } }, sessionId) }
      catch (error) { setError(message(error)) }
    }
    const result = page?.result
    const reading = result?.action === 'read'
    const recorded = Boolean(page?.receipt)
    const workspace = descriptor ? descriptor.kind === 'workspace' : !resource.sessionId
    const readable = descriptor && (!workspace || descriptor.capabilities.includes('搜索当前文件'))
    const title = reading ? result.items[0]?.title ?? '原文' : result?.action === 'search' ? `搜索：${page?.query ?? ''}` : descriptor?.title ?? resource.title
    const lines = reading && result.items[0]?.startLine ? `第 ${result.items[0].startLine}–${result.items[0].endLine} 行` : ''
    return <div className="dl dl-preview dl-reference-panel"><header>
      {history.length > 0 ? <button className="dl-reference-back" onClick={back}>返回{history.at(-1)?.result.action === 'search' ? '搜索结果' : '列表'}</button>
        : <button className="dl-reference-back" onClick={() => state.preview({ deviceId: resource.deviceId,
          workspace: descriptor?.workspacePath ?? resource.workspace, sessionId: descriptor?.sessionId ?? resource.sessionId,
          title: descriptor?.title ?? resource.title })}>返回{workspace ? '工作区' : '会话'}</button>}
      <h2>{title}</h2><small>{descriptor?.device}</small><p className="path">{descriptor?.workspacePath}</p>
      {result && (reading || recorded || result.source === 'cache') && <div className="dl-result-meta">
        {recorded && <span>当次结果</span>}{lines && <span>{lines}</span>}
        <span>{result.source === 'cache' ? '缓存于' : '读取于'} {new Date(result.observedAt).toLocaleString()}</span>
      </div>}
      {!recorded && descriptor?.availability !== 'online' && descriptor && <p className="dl-notice">{descriptor.availability === 'cached' ? '设备离线，正在浏览缓存' : '设备离线，无法读取文件'}</p>}
      {!recorded && !reading && <form className="dl-reference-search" onSubmit={event => { event.preventDefault(); void preview('search') }}>
        <input aria-label="搜索引用资料" placeholder={workspace ? '搜索文件名或代码' : '搜索会话内容'} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} />
        <button disabled={busy || !query.trim() || !readable}>搜索</button>
      </form>}
    </header><div className="body" ref={body}>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && <p role="status">正在读取…</p>}
      {resource.excerpt && !recorded && !reading && <blockquote>{resource.excerpt.text}</blockquote>}
      {result && <section className="dl-reference-result" aria-label={recorded ? '当次返回内容' : reading ? '文件正文' : '文件与会话列表'}>
        {page?.directory && <p className="path">{page.directory}</p>}
        {!result.items.length && <p className="empty">{result.action === 'search' ? '没有找到匹配内容' : workspace ? '此目录没有可读取的文件' : '没有可读取的会话内容'}</p>}
        {result.items.map((item, i) => reading ? <article key={`${item.path ?? item.seq}:${i}`}>
          <pre className="dl-source-text" onMouseUp={event => { const selected = window.getSelection(); setSelection(selected?.anchorNode && event.currentTarget.contains(selected.anchorNode) && selected.focusNode && event.currentTarget.contains(selected.focusNode) ? { text: selected.toString().slice(0, 4000), item } : undefined) }}>{item.text}</pre>
          {!recorded && (item.nextLine || item.nextOffset) && <button className="outline" disabled={busy} onClick={() => void preview('read', item, true)}>读取后续内容</button>}
        </article> : <div className="dl-file-entry" key={`${item.path ?? item.seq}:${i}`}>
          {recorded ? <><strong>{item.title}</strong>{item.text && <pre className="dl-search-excerpt">{item.text}</pre>}</>
            : <button className="resource-main" disabled={busy} onClick={() => void preview(item.revision ? 'read' : 'inspect', item)}>
              {!item.revision && <primitives.IconFolderCloseRegular size={16} />}<span className="grow"><span>{item.title}</span>
                {item.text && <span className="dl-search-excerpt">{item.text}</span>}</span><primitives.IconChevronRightOutlineRegular size={14} />
            </button>}
        </div>)}
        {result.tasks?.map(task => <section key={task.id}><h3>{statusLabels[task.status]}</h3><p>{task.prompt}</p>{task.error && <p className="error">{task.error}</p>}{task.text && <p>{task.text}</p>}{task.truncated && <small>任务记录已截断</small>}</section>)}
        {result.truncated && <p className="dl-notice">{reading ? '这次返回的内容不完整' : '仅显示部分结果'}{!recorded && result.action === 'search' ? '，请缩小搜索范围' : ''}</p>}
        {selection?.text && reading && <button className="outline" onClick={quote}>引用选中文字</button>}
        {!reading && <div className="dl-scope-detail"><button aria-expanded={showScope} onClick={() => setShowScope(!showScope)}>范围详情</button>{showScope && <p>{result.coverage}</p>}</div>}
      </section>}
    </div></div>
  }
}
