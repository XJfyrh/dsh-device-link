import type * as ReactTypes from 'react'
import type { AccountRelation, Scope, WorkspaceFact } from '../lib/types.js'
import type { PeerView } from '../lib/connect.js'
import type { Diagnostic } from '../lib/network.js'
import type { TabProps, ClientPrimitives, CreatePortal } from './contracts.js'
import { api, cacheLabel, message, openDeviceUi, parseAddress, parseReference, type ClientState, type Resource, type SessionSnapshot, type SentReferenceData } from './state.js'
import { statusLabels } from './conversation.js'
import { createScopeComponents } from './scope.js'
import { createChoiceField } from './choice-field.js'
import { createTaskComponents } from './tasks.js'
import { relativeTime, workspaceName } from '../lib/presentation.js'
import { createReferencePanel } from './reference-panel.js'
import { createDeviceIcon } from './icons.js'
import type { ReadReceipt, ReferenceDescriptor } from '../lib/references.js'

const defaultScope = (same = false): Scope => ({ workspaces: same ? 'all' : [], allowUi: same, allowDelegate: same, sessionSync: same ? 'content' : 'none', sessionIds: 'all', allowReadFiles: same, sessionTools: false })
const time = (value?: string | null) => value ? new Date(value).toLocaleString() : '尚未同步'

export function createComponents(React: typeof ReactTypes, state: ClientState, primitives: ClientPrimitives, createPortal: CreatePortal) {
  const { MarkdownText } = primitives
  const DeviceIcon = createDeviceIcon(React)
  const { useState, useEffect, useRef, useSyncExternalStore } = React
  const ChoiceField = createChoiceField(React, primitives, createPortal)
  const ReferencePanel = createReferencePanel(React, state, primitives)
  const { ScopeFields, TrustedCard, cleanScope } = createScopeComponents(React, ChoiceField, primitives)
  const useView = () => useSyncExternalStore(state.subscribe, state.getSnapshot)
  function Markdown({ text }: { text: string }) {
    return <div className="dl-markdown"><MarkdownText text={text} labels={{ code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' }} /></div>
  }
  const { TaskCard, TasksPage } = createTaskComponents(React, state, Markdown, primitives, createPortal)
  function useAction() {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    async function run(operation: () => Promise<unknown> | unknown) {
      setBusy(true); setError('')
      try { await operation() } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
    }
    return { busy, error, run }
  }
  function ErrorText({ text }: { text: string }) { return text ? <p className="error" role="alert">{text}</p> : null }
  function NavigationArrow() { return <span className="dl-navigation-arrow" aria-hidden="true"><primitives.IconChevronRightOutlineRegular size={14} /></span> }
  function ResourceIcon({ kind }: { kind: 'workspace' | 'session' | 'agent' }) {
    return <span className={`dl-resource-icon dl-resource-icon-${kind}`} aria-hidden="true">{kind === 'agent' ? <primitives.IconAgentPresetOutlineRegular size={16} /> : <primitives.ReferenceIconRegular kind={kind === 'workspace' ? 'folder' : 'session'} size={16} />}</span>
  }
  function Status({ peer }: { peer: PeerView }) { return <span className="status"><i className={`dot ${peer.online ? 'online' : ''}`} />{peer.checking ? '检查中…' : peer.online ? '在线' : '离线'}</span> }
  async function favorite(peer: PeerView, workspace: WorkspaceFact, enabled: boolean) {
    await api('favorite', { deviceId: peer.deviceId, path: workspace.path, enabled }); await state.refresh()
  }
  function WorkspaceRow({ peer, workspace }: { peer: PeerView; workspace: WorkspaceFact }) {
    const view = useView()
    const action = useAction()
    const saved = view.data?.favorites.some(item => item.deviceId === peer.deviceId && item.path === workspace.path)
    return <div><div className="resource-row">
      <button className="resource-main" onClick={() => state.preview({ deviceId: peer.deviceId, workspace: workspace.path, title: workspace.title })}>
        <ResourceIcon kind="workspace" /><span className="grow"><strong>{workspace.title}</strong><small title={workspace.path}>{workspace.path}</small></span>
      </button>
      <button className={`star ${saved ? 'selected' : ''}`} aria-label={`${saved ? '取消收藏' : '收藏'} ${workspace.title}`} disabled={action.busy} onClick={() => void action.run(() => favorite(peer, workspace, !saved))}>{saved ? '★' : '☆'}</button>
    </div><ErrorText text={action.error} /></div>
  }
  function Sidebar({ wide }: { wide: boolean }) {
    const view = useView()
    const online = view.data?.peers.filter(peer => peer.online).length ?? 0
    return <div className="dl dl-footer">
      <button className={`device-trigger ${wide ? '' : 'rail'}`} aria-label="设备" title={`${online} 台设备在线`} aria-expanded={view.panel !== null} aria-haspopup="dialog"
        onClick={() => state.change({ panel: view.panel ? null : 'list' })}>
        <DeviceIcon />
        {wide ? <><span className="grow">设备</span><small>{!view.data || view.data.peers.some(peer => peer.checking) ? '检查中…' : `${online} 在线`}</small></> : online > 0 && <i className="dot online" aria-hidden="true" />}
      </button>
    </div>
  }
  function Favorites({ query }: { query: string }) {
    const view = useView()
    const action = useAction()
    const peers = view.data?.peers ?? []
    const favorites = (view.data?.favorites ?? []).filter(item => `${item.title} ${item.path} ${peers.find(peer => peer.deviceId === item.deviceId)?.name}`.toLowerCase().includes(query))
    if (!favorites.length) return null
    return <section className="dl-favorites" aria-label="收藏的工作区">
      <h3 className="section-label">收藏的工作区</h3>
        <div className="favorites">{favorites.map(item => {
          const peer = peers.find(peer => peer.deviceId === item.deviceId)
          if (!peer) return null
          return <div key={`${item.deviceId}:${item.path}`} className="favorite-row">
            <button className="resource-main" onClick={() => state.preview({ deviceId: item.deviceId, workspace: item.path, title: item.title })} title={item.path}>
              <ResourceIcon kind="workspace" /><span className="grow"><strong className="ellipsis">{item.title}</strong><small className="dl-device-source"><i className={`dot ${peer.online ? 'online' : ''}`} aria-label={peer.online ? '在线' : '离线'} /><span className="ellipsis">{peer.name}</span></small></span>
            </button><button className="remove" aria-label={`取消收藏 ${item.title}`} onClick={() => void action.run(() => favorite(peer, { id: item.path, ...item }, false))}>×</button>
          </div>
        })}</div>
      <ErrorText text={action.error} />
    </section>
  }
  function LocalDeviceName() {
    const fieldId = React.useId()
    const view = useView()
    const current = view.data?.identity.name ?? ''
    const [name, setName] = useState(current)
    const action = useAction()
    useEffect(() => setName(current), [current])
    return <form className="dl-device-name" onSubmit={event => {
      event.preventDefault()
      void action.run(async () => {
        await api('rename', { name })
        await state.refresh()
        state.notify('本机名称已保存')
      })
    }}>
      <label htmlFor={fieldId}>本机名称</label><div className="row"><input id={fieldId} value={name} maxLength={64} disabled={action.busy} onChange={event => setName(event.target.value)} /><button type="submit" className="outline" disabled={action.busy || !name.trim() || name.trim() === current}>{action.busy ? '保存中…' : '保存'}</button></div>
      <ErrorText text={action.error} />
    </form>
  }
  function HostPairing() {
    const view = useView()
    const [relation, setRelation] = useState<AccountRelation>('unknown')
    const [scope, setScope] = useState(defaultScope())
    const [now, setNow] = useState(Date.now())
    const action = useAction()
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
    const remaining = view.data?.pairing ? Math.max(0, Math.ceil((Date.parse(view.data.pairing.expiresAt) - now) / 1000)) : 0
    if (!view.data) return <p role="status">正在加载本机设置…</p>
    return <><LocalDeviceName />
      {view.data?.addresses.map(address => <p className="path" key={address}>{address}</p>)}
      <label><input type="checkbox" checked={view.data?.allowIncoming ?? false} disabled={action.busy} onChange={event => void action.run(async () => { await api('toggle', { allowIncoming: event.target.checked }); await state.refresh() })} />允许局域网设备连接</label>
      <ChoiceField<AccountRelation> label="首次配对的账号关系" value={relation} onChange={value => { setRelation(value); setScope(defaultScope(value === 'same-account')) }} options={[
        { value: 'unknown', label: '待确认' }, { value: 'same-account', label: '我已确认使用同一账号' }, { value: 'different-account', label: '使用不同账号' },
      ]} /><ScopeFields value={scope} onChange={setScope} workspaces={view.data?.host.workspaces} sessions={view.data?.host.sessions} />
      <button className="primary" disabled={action.busy || !view.data?.allowIncoming} onClick={() => void action.run(async () => { await api('allow', { relationship: relation, scope: cleanScope(scope) }); await state.refresh() })}>生成配对码</button>
      {remaining > 0 && <div><p className="code">{view.data?.pairing?.code}</p><small>{remaining} 秒后过期，只能使用一次</small><button onClick={() => void action.run(async () => { await api('close-pairing', {}); await state.refresh() })}>关闭配对码</button></div>}
      <ErrorText text={action.error} /></>
  }
  function PairForm() {
    const [address, setAddress] = useState('')
    const [code, setCode] = useState('')
    const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null)
    const action = useAction()
    return <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      await api('pair', { address, code }); await state.refresh(); state.change({ panel: 'list' }); state.notify('设备已连接')
    }) }}>
      <p className="muted">在另一台设备打开“允许连接本机”，填写它的地址与配对码。</p>
      <label>设备地址<input autoFocus placeholder="192.168.1.5:47654" value={address} onChange={event => setAddress(event.target.value)} /></label>
      <label>配对码<input inputMode="numeric" autoComplete="off" maxLength={8} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /></label>
      <div className="actions"><button className="primary" type="submit" disabled={action.busy || !address || code.length !== 8}>{action.busy ? '连接中…' : '连接设备'}</button>
        <button type="button" disabled={action.busy || !address} onClick={() => void action.run(async () => { setDiagnostic((await api<{ diagnostic: Diagnostic }>('diagnose', { address })).diagnostic) })}>诊断连接</button></div>
      {diagnostic && <div className="divider" role="status"><p>{diagnostic.message}</p><small>耗时 {diagnostic.elapsedMs} ms</small>{diagnostic.interfaces.map(item => <small key={item.address}>{item.name}：{item.address}</small>)}</div>}
      <ErrorText text={action.error} />
    </form>
  }
  function PeerDetail({ peer, managing, setManaging }: { peer: PeerView; managing: boolean; setManaging(value: boolean): void }) {
    const [tab, setTab] = useState('workspaces')
    const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null)
    const action = useAction()
    async function openRemote() {
      await openDeviceUi(peer.deviceId)
    }
    if (managing) return <div className="dl-management">
      <div className="row between"><h2>{peer.name}</h2><Status peer={peer} /></div>
      <section><h3>连接信息</h3><dl className="dl-facts"><dt>地址</dt><dd>{peer.baseUrl}</dd><dt>系统</dt><dd>{peer.status?.host.platform ?? '系统未知'}</dd><dt>同步时间</dt><dd>{time(peer.cachedAt)}</dd></dl>
        <div className="actions"><button className="outline" disabled={action.busy} onClick={() => void action.run(async () => { await api('sync', { deviceId: peer.deviceId }); await state.refresh() })}>刷新设备</button>
          <button className="dl-icon-label" disabled={!peer.online || !peer.status?.scope.allowUi || action.busy} onClick={() => void action.run(openRemote)}>打开设备界面<primitives.IconRightUpOutlineRegular size={14} /></button>
          <button disabled={action.busy} onClick={() => void action.run(async () => { setDiagnostic((await api<{ diagnostic: Diagnostic }>('diagnose', { address: peer.baseUrl })).diagnostic) })}>诊断连接</button></div>
        {diagnostic && <div role="status"><p>{diagnostic.ok ? '设备连接地址可达' : diagnostic.message}</p><small>耗时 {diagnostic.elapsedMs} ms</small></div>}
      </section>
      <section><h3>我在此设备上的访问权限</h3><dl className="dl-facts"><dt>执行任务</dt><dd>{peer.status?.scope.allowDelegate ? '允许' : '未授权'}</dd><dt>查看会话</dt><dd>{peer.status?.scope.sessionSync === 'content' ? '可读取正文' : peer.status?.scope.sessionSync === 'metadata' ? '只能查看目录' : '未授权'}</dd><dt>设备界面</dt><dd>{peer.status?.scope.allowUi ? '允许打开' : '未授权'}</dd></dl><small>这些权限由 {peer.name} 授予，需要在该设备上修改。</small></section>
      <section><h3>执行环境</h3><dl className="dl-facts"><dt>默认模型</dt><dd>{peer.status?.host.model.model ?? '未配置'}</dd><dt>模型提供方</dt><dd>{peer.status?.host.model.provider ?? '未配置'}</dd><dt>插件版本</dt><dd>{peer.status?.device.version ?? '未知'}</dd></dl><small>任务和浏览器会话在 {peer.name} 上运行。</small></section>
      <section><h3>断开连接</h3><small>移除此设备的连接与本地缓存。</small><div className="actions"><button className="danger" disabled={action.busy} onClick={() => { if (window.confirm(`断开 ${peer.name} 并移除本地缓存？`)) void action.run(async () => {
        const result = await api<{ remoteRevoked: boolean }>('revoke', { deviceId: peer.deviceId }); await state.refresh(); state.change({ panel: 'list' })
        state.notify(result.remoteRevoked ? '已断开设备' : '本地连接已移除。对端不可达，请在对端撤销授权。')
      }) }}>断开设备</button></div></section><ErrorText text={action.error} />
    </div>
    return <><div className="row between"><h2>{peer.name}</h2><div className="row"><Status peer={peer} /><button onClick={() => setManaging(true)}>管理设备</button></div></div>
      <small className="dl-meta"><span>{peer.status?.host.workspaces.length ?? 0} 个工作区</span><span>{peer.cachedSessionIds.length} 个已缓存会话</span></small>
      {!peer.online && <p className="muted divider">设备离线，可查看已缓存的会话正文。</p>}
      {peer.update !== 'current' && peer.update !== 'unknown' && <p className="muted">{peer.update === 'remote-older' ? '对方设备插件可更新' : '本机插件可更新'}，对方设备版本 {peer.status?.device.version}</p>}
      <div className="tabs" role="tablist" aria-label="设备资源">{([{ value: 'workspaces', label: '工作区', kind: 'workspace' }, { value: 'sessions', label: '会话', kind: 'session' }, { value: 'agents', label: '智能体', kind: 'agent' }] as const).map(({ value, label, kind }) => <button className="dl-resource-tab" role="tab" key={value} aria-selected={tab === value} onClick={() => setTab(value)}><ResourceIcon kind={kind} />{label}</button>)}</div>
      {tab === 'workspaces' && <>{peer.status?.host.workspaces.map(workspace => <WorkspaceRow key={workspace.id} peer={peer} workspace={workspace} />)}{!peer.status?.host.workspaces.length && <p className="empty">暂无授权工作区</p>}</>}
      {tab === 'sessions' && <>{peer.status?.host.sessions.map(session => <button className="resource-main" key={session.id} onClick={() => state.execute({ deviceId: peer.deviceId, sessionId: session.id, workspace: session.cwd, title: session.title })}>
        <ResourceIcon kind="session" /><span className="grow"><strong>{session.title}</strong><small className="dl-meta"><span>{workspaceName(session.cwd)}</span><span>{relativeTime(session.updatedAt)}</span><span>{cacheLabel(peer, session.id)}</span></small></span><NavigationArrow />
      </button>)}{!peer.status?.host.sessions.length && <p className="empty">暂无授权会话</p>}</>}
      {tab === 'agents' && <>{peer.status?.host.agents.map(agent => <button className="resource-main" key={agent.id} onClick={() => state.execute({ deviceId: peer.deviceId, sessionId: agent.id, workspace: agent.cwd, title: agent.title ?? '新会话' })}><ResourceIcon kind="agent" /><span className="grow"><strong>{agent.title ?? '新会话'}</strong><small className="dl-meta"><span>{agent.status === 'running' ? '正在执行' : '等待下一条任务'}</span><span>{workspaceName(agent.cwd)}</span></small></span><NavigationArrow /></button>)}{!peer.status?.host.agents.length && <p className="empty">暂无活动智能体</p>}</>}
      <ErrorText text={action.error} /></>
  }
  function DevicePanel() {
    const view = useView()
    const [query, setQuery] = useState('')
    const [managing, setManaging] = useState(false)
    const dialog = useRef<HTMLElement>(null)
    const route = view.panel
    primitives.useModalLayer(dialog, Boolean(route && route !== 'settings'), () => state.change({ panel: null }))
    useEffect(() => setManaging(false), [route])
    useEffect(() => {
      if (!route || route === 'settings') return
      function outside(event: PointerEvent) {
        const target = event.target as HTMLElement
        if (!dialog.current?.contains(target) && !target.closest('.device-trigger, .dl-choice-menu')) state.change({ panel: null })
      }
      document.addEventListener('pointerdown', outside)
      return () => document.removeEventListener('pointerdown', outside)
    }, [route])
    if (!route || route === 'settings') return null
    const peer = view.data?.peers.find(item => item.deviceId === route)
    const search = query.trim().toLowerCase()
    const peers = (view.data?.peers ?? []).filter(peer => `${peer.name} ${peer.status?.host.workspaces.map(item => `${item.title} ${item.path}`).join(' ')}`.toLowerCase().includes(search))
    const root = route === 'list' || route === 'all'
    const groups = peers.map(peer => ({ peer, workspaces: (peer.status?.host.workspaces ?? []).filter(workspace => `${peer.name} ${workspace.title} ${workspace.path}`.toLowerCase().includes(search)) })).filter(group => group.workspaces.length)
    const saved = (peer: PeerView, workspace: WorkspaceFact) => view.data?.favorites.some(item => item.deviceId === peer.deviceId && item.path === workspace.path)
    return <section ref={dialog} className="dl dl-popover" role="dialog" aria-modal="true" tabIndex={-1} aria-label="设备面板">
      <header className="row between"><div>{root ? <h2>设备</h2> : <button className="dl-icon-label" onClick={() => managing ? setManaging(false) : state.change({ panel: 'list' })}><primitives.IconChevronLeftOutlineRegular size={14} />{peer ? managing ? '设备资源' : '设备列表' : route === 'pair' ? '连接新设备' : '允许连接本机'}</button>}</div>
        <div className="row">{root && <button className="primary" onClick={() => state.change({ panel: 'pair' })}>＋ 连接设备</button>}<button aria-label="关闭设备面板" onClick={() => state.change({ panel: null })}>×</button></div>
      </header>
      {root && <><div className="tabs dl-panel-tabs" role="tablist" aria-label="浏览设备与工作区"><button role="tab" aria-selected={route === 'list'} onClick={() => { setQuery(''); state.change({ panel: 'list' }) }}>设备</button><button role="tab" aria-selected={route === 'all'} onClick={() => { setQuery(''); state.change({ panel: 'all' }) }}>工作区</button></div><div className="search"><input aria-label={route === 'list' ? '搜索设备' : '搜索工作区'} placeholder={route === 'list' ? '搜索设备' : '搜索工作区'} value={query} onChange={event => setQuery(event.target.value)} /></div></>}
      <div className="body"><ErrorText text={view.error} />{route === 'pair' && <PairForm />}{route === 'host' && <HostPairing />}{peer && <PeerDetail key={peer.deviceId} peer={peer} managing={managing} setManaging={setManaging} />}
        {route === 'list' && <>{peers.map(peer => <button className="dl-device-row" key={peer.deviceId} onClick={() => state.change({ panel: peer.deviceId })}>
          <DeviceIcon /><span className="grow"><strong>{peer.name}</strong><small className="dl-meta"><span>{peer.status?.host.workspaces.length ?? 0} 个工作区</span><span>{peer.cachedSessionIds.length} 个缓存会话</span></small></span><Status peer={peer} /><NavigationArrow />
        </button>)}{!peers.length && <div className="empty"><p>{!view.data ? '正在加载设备…' : search ? '未找到设备' : '连接另一台设备，访问它的工作区'}</p></div>}
        </>}
        {route === 'all' && <><Favorites query={search} />{groups.map(({ peer, workspaces }) => {
          const remaining = workspaces.filter(workspace => !saved(peer, workspace))
          return remaining.length ? <section key={peer.deviceId} className="dl-workspace-group" aria-label={`${peer.name} 的工作区`}><div className="row between"><h3 className="section-label">{peer.name}</h3><Status peer={peer} /></div>{remaining.map(workspace => <WorkspaceRow key={workspace.id} peer={peer} workspace={workspace} />)}</section> : null
        })}{!groups.length && <p className="empty">{!view.data || peers.some(peer => peer.checking) ? '正在加载工作区…' : search ? '未找到工作区' : '连接设备后，在这里查看和收藏工作区'}</p>}</>}
      </div><footer className="row between"><button onClick={() => state.change({ panel: 'host' })}>允许连接本机</button><button onClick={() => state.change({ panel: 'settings' })}>连接设置</button></footer>
    </section>
  }
  function Settings() {
    const view = useView()
    const action = useAction()
    if (!view.data) return <div className="dl dl-settings"><h2>设备连接设置</h2><ErrorText text={view.error} /><p role="status">正在加载本机设置…</p></div>
    return <div className="dl dl-settings"><h2>设备连接设置</h2><ErrorText text={view.error || action.error} />
      <section><LocalDeviceName /><p className="path">监听地址：{view.data?.listen?.host}:{view.data?.listen?.port}</p>
        <label><input type="checkbox" checked={view.data?.allowIncoming ?? false} disabled={action.busy} onChange={event => void action.run(async () => { await api('toggle', { allowIncoming: event.target.checked }); await state.refresh() })} />允许局域网设备连接</label>
        <button className="outline" onClick={() => state.change({ panel: 'host' })}>生成配对码</button>
      </section><section><h3>已授权连接本机的设备</h3>{view.data?.trusted.map(device => <TrustedCard key={device.deviceId} device={device} workspaces={view.data?.host.workspaces} sessions={view.data?.host.sessions} changed={() => void state.refresh()} />)}{!view.data?.trusted.length && <p className="muted">尚未授权设备</p>}</section>
      <section><h3>连接与运行配置</h3><p className="muted">在 Harness 插件配置中设置监听地址和端口。跨物理机连接使用本机局域网 IPv4 地址。</p><dl className="dl-facts"><dt>当前地址</dt><dd>{view.data?.addresses.map(address => <div key={address}>{address}</div>)}</dd></dl><button className="outline" onClick={() => state.change({ panel: 'list' })}>管理已连接设备</button></section>
    </div>
  }
  function Preview({ resource, sessionId }: { resource: Resource; sessionId?: string }) {
    return resource.referenceId ? <ReferencePanel resource={resource} sessionId={sessionId} /> : <ResourcePreview resource={resource} sessionId={sessionId} />
  }
  function ResourcePreview({ resource, sessionId }: { resource: Resource; sessionId?: string }) {
    const view = useView()
    const peer = view.data?.peers.find(peer => peer.deviceId === resource.deviceId)
    const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [selectedText, setSelectedText] = useState<{ text: string; seq?: number }>()
    const action = useAction()
    const hasCache = peer?.cachedSessionIds.includes(resource.sessionId ?? '')
    useEffect(() => {
      setSnapshot(null); setLoadError(''); setSelectedText(undefined); setLoading(false)
      if (!resource.sessionId) return
      const controller = new AbortController()
      setLoading(true)
      api<SessionSnapshot>('session', { deviceId: resource.deviceId, sessionId: resource.sessionId, refresh: !hasCache && peer?.online && peer.status?.scope.sessionSync === 'content' }, controller.signal)
        .then(setSnapshot).catch(error => { if (!controller.signal.aborted) setLoadError(message(error)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
      return () => controller.abort()
    }, [resource.deviceId, resource.sessionId, hasCache])
    const workspace = snapshot?.session.cwd ?? resource.workspace
    const actual = { ...resource, workspace, title: snapshot?.session.title ?? resource.title }
    const sessions = peer?.status?.host.sessions.filter(item => item.cwd === workspace) ?? []
    async function syncSession() {
      const next = await api<SessionSnapshot>('session', { deviceId: resource.deviceId, sessionId: resource.sessionId, refresh: true })
      setSnapshot(next); setLoadError(''); await state.refresh()
    }
    const recent = new Map(sessions.map(session => [session.id, session]))
    for (const task of view.tasks.filter(task => task.deviceId === resource.deviceId && task.workspacePath === workspace)) {
      if (task.remote && !recent.has(task.remote.sessionId)) recent.set(task.remote.sessionId, { id: task.remote.sessionId, title: task.prompt.slice(0, 60), cwd: task.workspacePath, updatedAt: Date.parse(task.remote.updatedAt), live: false })
    }
    return <div className="dl dl-preview"><header><div className="row between"><h2>{resource.sessionId ? actual.title : peer?.status?.host.workspaces.find(item => item.path === workspace)?.title ?? workspaceName(workspace)}</h2>{peer && <Status peer={peer} />}</div><small>{peer?.name ?? '连接已移除'}</small><p className="path" aria-label="工作区位置">{workspace}</p></header>
      <div className="body"><ErrorText text={action.error || loadError} />
        {resource.sessionId ? <>{loading && <p className="muted">正在读取会话…</p>}
          {snapshot && <><small>缓存于 {time(snapshot.cachedAt)}{snapshot.session.truncated ? '，内容已截断' : ''}</small>
            {snapshot.session.messages.map((item, index) => <div className="message" data-role={item.role} key={item.seq ?? index} onMouseUp={event => { const selected = window.getSelection(); const text = selected?.anchorNode && event.currentTarget.contains(selected.anchorNode) && selected.focusNode && event.currentTarget.contains(selected.focusNode) ? selected.toString().slice(0, 4000) : ''; setSelectedText(text ? { text, seq: item.seq } : undefined) }}><strong>{item.role === 'user' ? '用户' : '智能体'}</strong>{item.role === 'assistant' ? <Markdown text={item.text} /> : <p>{item.text}</p>}</div>)}
            {!snapshot.session.messages.length && <p className="empty">此会话暂无对话正文</p>}
            {snapshot.session.tasks?.map(task => <section key={task.id}><h3>{statusLabels[task.status]}</h3><p>{task.prompt}</p>{task.error && <p className="error">{task.error}</p>}{task.text && <Markdown text={task.text} />}{task.truncated && <small>任务记录已截断</small>}</section>)}</>}
          {peer?.online && peer.status?.scope.sessionSync === 'content' && <button className="outline" disabled={action.busy} onClick={() => void action.run(syncSession)}>更新会话缓存</button>}
        </> : <><div className="actions"><button className="primary" disabled={!peer?.online || !peer.status?.scope.allowDelegate} onClick={() => state.execute(actual)}>新建任务</button>
          <button className="outline" disabled={!peer} onClick={() => void action.run(() => state.quote(actual, sessionId))}>添加到当前任务</button>
          <button className="outline" disabled={!peer?.status?.scope.allowReadFiles} onClick={() => void action.run(async () => { const result = await api<{ descriptor: { id: string } }>('reference-prepare', { deviceId: resource.deviceId, workspacePath: workspace }); state.preview({ ...actual, referenceId: result.descriptor.id }) })}>浏览资料</button></div>
          {!peer?.status?.scope.allowReadFiles && <p className="dl-notice">文件读取未获授权，可在设备上调整连接授权。</p>}
          {!peer?.online && <p className="dl-notice">设备离线，可阅读已缓存会话，恢复连接后可新建任务。</p>}
          {peer?.online && !peer.status?.scope.allowDelegate && <p className="dl-notice">此工作区未授权执行任务。请在设备上调整连接授权。</p>}
          <p className="section-label">最近会话</p>{[...recent.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(item => <button className="resource-main" key={item.id} onClick={() => state.execute({ deviceId: resource.deviceId, workspace, sessionId: item.id, title: item.title })}><ResourceIcon kind="session" /><span className="grow"><strong>{item.title}</strong><small className="dl-meta"><span>{relativeTime(item.updatedAt)}</span><span>{peer?.cachedSessionIds.includes(item.id) ? cacheLabel(peer, item.id) : view.tasks.some(task => task.remote?.sessionId === item.id && task.deviceId === resource.deviceId) ? '任务结果可读' : '仅会话目录'}</span></small></span><NavigationArrow /></button>)}{!recent.size && <div className="empty"><p>还没有会话</p><small>从上方新建任务开始，后续可在这里继续。</small></div>}</>}
      </div>{resource.sessionId && <footer><div className="actions"><button className="outline" disabled={!peer || !snapshot} onClick={() => void action.run(() => state.quote(actual, sessionId))}>添加到当前任务</button>
        {selectedText && snapshot && <button className="outline" onClick={() => void action.run(() => state.quote({ ...actual, excerpt: { ...selectedText, cachedAt: snapshot.cachedAt } }, sessionId))}>引用选中文字</button>}
        <button className="primary" disabled={!workspace} onClick={() => state.execute(actual)}>打开完整对话</button>
      </div></footer>}
    </div>
  }
  function ResourceTab(props: TabProps) {
    const { tab } = props.useTabInfo()
    try { return <Preview resource={parseAddress(tab.navigation.address)} sessionId={props.sessionId} /> } catch { return <div className="dl empty">无法读取此设备引用</div> }
  }
  function SentReference({ node, interactive }: { node: { data: SentReferenceData }; interactive: boolean }) {
    const data = node.data
    const { device, title, kind } = data.descriptor
    return <span className="dl"><button className="dl-reference" disabled={!interactive} title={data.excerpt ? '已附选中原文' : '按需读取的设备资料'}
      onClick={() => state.preview({ ...parseReference(data.ref), title: data.label, referenceId: data.referenceId, excerpt: data.excerpt })}><ResourceIcon kind={kind} /> {device}<span className="dl-inline-chevron" aria-hidden="true"><primitives.IconChevronRightOutlineRegular size={12} /></span>{title}{data.excerpt ? '（原文）' : ''}</button></span>
  }
  function ResourceToolRow({ callId, sessionId, phase, block, inspect }: { callId: string; sessionId: string; phase: string; block: { isError?: boolean; error?: { message?: string } }; inspect?: () => void }) {
    const [call, setCall] = useState<{ descriptor: ReferenceDescriptor; receipt: ReadReceipt } | null>(null)
    useEffect(() => {
      const controller = new AbortController()
      const refresh = () => api<{ call: typeof call }>('reference-call', { localSessionId: sessionId, callId }, controller.signal).then(value => setCall(value.call)).catch(() => {})
      void refresh(); const timer = setInterval(() => void refresh(), 2500)
      return () => { controller.abort(); clearInterval(timer) }
    }, [callId, sessionId, phase])
    const receipt = call?.receipt
    const title = block.isError ? '读取失败' : !receipt ? phase === 'result' ? '读取记录不可用' : '正在读取设备资料…'
      : receipt.action === 'search' ? `搜索 ${receipt.query}` : receipt.action === 'read' ? `读取 ${receipt.result.items[0]?.title ?? '会话原文'}`
        : call.descriptor.kind === 'workspace' ? '浏览工作区' : '浏览会话'
    const item = receipt?.result.items[0]
    const detail = receipt?.action === 'search' ? `${receipt.result.items.length} ${call?.descriptor.kind === 'workspace' ? '个文件' : '条记录'}`
      : receipt?.action === 'read' && item?.startLine ? `第 ${item.startLine}${item.endLine !== item.startLine ? `–${item.endLine}` : ''} 行` : ''
    const open = () => call ? state.preview({ deviceId: call.descriptor.deviceId, workspace: call.descriptor.workspacePath,
      sessionId: call.descriptor.sessionId, title, referenceId: call.descriptor.id,
      receiptId: call.receipt.id, sourceSessionId: sessionId }) : inspect?.()
    return <div className="dl dl-resource-tool">
      <div className="dl-resource-operation"><button className={`dl-resource-open ${block.isError ? 'error' : ''}`} onClick={open} disabled={!call && !inspect}
        title={call ? `${call.descriptor.device}：${title}，查看当次结果` : title}>
        <span className="dl-resource-label">{title}</span>{detail && <small>{detail}</small>}
        {receipt?.result.source === 'cache' && <small>缓存</small>}{receipt?.result.truncated && <small>结果不完整</small>}
        {(call || inspect) && <primitives.IconChevronRightOutlineRegular size={14} />}
      </button>{call && inspect && <button className="dl-resource-diagnostic" aria-label="查看工具调用详情" title="查看工具调用详情" onClick={inspect}>…</button>}</div>
      {block.isError && <p className="error">{block.error?.message ?? '未取得资料'}</p>}
    </div>
  }
  function ToolCard({ callId, sessionId, phase, block, inspect }: { callId: string; sessionId: string; phase: string; block: { isError?: boolean; error?: { message?: string } }; inspect?: () => void }) {
    const view = useView()
    const task = view.tasks.find(item => item.originCallId === callId && item.originSessionId === sessionId)
    return <div className="dl">{task ? <TaskCard task={task} source="local" /> : <div className="dl-task"><p>{phase === 'result' ? '此任务记录不可用' : '正在提交设备任务…'}</p></div>}
      {block.isError && <ErrorText text={block.error?.message ?? '工具调用失败'} />}
      {inspect && <button className="muted" onClick={inspect}>工具调用详情</button>}
    </div>
  }
  function Overlay() {
    const view = useView()
    // The shell overlay sits below the native narrow-screen sidebar drawer.
    return createPortal(<><DevicePanel />
      {view.preview && <aside className="dl dl-fallback" aria-label="设备预览"><button aria-label="关闭设备预览" style={{ position: 'absolute', right: 8, top: 8, zIndex: 1 }} onClick={() => state.change({ preview: null })}>×</button><Preview resource={view.preview} /></aside>}
      {view.panel === 'settings' && <section className="dl dl-settings-modal" role="dialog" aria-label="设备连接设置" onKeyDown={event => { if (event.key === 'Escape') state.change({ panel: null }) }}><button autoFocus aria-label="关闭连接设置" style={{ float: 'right', margin: 12 }} onClick={() => state.change({ panel: null })}>×</button><Settings /></section>}
      {view.toast && <div className="dl dl-toast" role="status">{view.toast}</div>}
    </>, document.body)
  }
  function PanelIcon() { return <primitives.IconChecklistOutlineRegular size={16} /> }
  return { Sidebar, Overlay, Settings, ResourceTab, ToolCard, ResourceToolRow, TasksPage, PanelIcon, SentReference }
}
