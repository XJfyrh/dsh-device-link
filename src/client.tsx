import type * as ReactTypes from 'react'
import type { DeviceState } from './lib/api.js'
import type { Scope, AccountRelation, SessionContent, DelegateResult } from './lib/types.js'
import type { PeerView } from './lib/connect.js'
import type { Diagnostic } from './lib/network.js'

interface Candidate { name: string; label: string; description: string; value: string; icon: 'folder' | 'session' }
interface ClientContext {
  slots: { inject(name: string, factory: () => unknown): unknown; register(options: { name: string; id: string; order: number; label: string }, component: ReactTypes.ComponentType): unknown }
  inputTriggers: { registerSource(source: {
    trigger: '@'; name: string; order: number
    candidates(session: unknown, request: { query: string; signal: AbortSignal }): Promise<Candidate[]>
    onPick(pick: { candidate: Candidate }): { text: string }
  }): () => void }
  effect(factory: () => (() => void)): void
}
declare global {
  interface Window {
    __ModuleLoader__: { load(module: { id: string; factory(require: (name: 'react') => typeof ReactTypes): { inject: string[]; apply(ctx: ClientContext): void } }): void }
  }
}

async function api<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/device-link/api/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
  const payload = await response.json() as T & { ok?: boolean; error?: string }
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function defaultScope(same = false): Scope { return { workspaces: same ? 'all' : [], allowUi: same, allowDelegate: same, sessionSync: same ? 'content' : 'none', sessionIds: 'all' } }

window.__ModuleLoader__.load({ id: 'dsh-device-link', factory(require) {
  const React = require('react')
  const { useState, useEffect, useCallback } = React

  function ScopeFields({ value, onChange }: { value: Scope; onChange(value: Scope): void }) {
    function update(next: Partial<Scope>) {
      const merged = { ...value, ...next }
      if (merged.workspaces !== 'all' || merged.sessionSync !== 'content' || merged.sessionIds !== 'all') merged.allowUi = false
      onChange(merged)
    }
    return <fieldset className="dl-scope">
      <legend>授权范围</legend>
      <label><input type="checkbox" checked={value.workspaces === 'all'} onChange={event => update({ workspaces: event.target.checked ? 'all' : [] })} />全部工作区</label>
      {value.workspaces !== 'all' && <label>工作区绝对路径，每行一个<textarea rows={3} value={value.workspaces.join('\n')} placeholder="E:\project" onChange={event => update({ workspaces: event.target.value.split('\n') })} /></label>}
      <label><input type="checkbox" checked={value.allowDelegate} onChange={event => update({ allowDelegate: event.target.checked })} />允许委派任务</label>
      <label>会话同步<select value={value.sessionSync} onChange={event => update({ sessionSync: event.target.value as Scope['sessionSync'] })}>
        <option value="none">关闭</option><option value="metadata">会话目录</option><option value="content">目录与对话正文</option>
      </select></label>
      {value.sessionSync !== 'none' && <>
        <label><input type="checkbox" checked={value.sessionIds === 'all'} onChange={event => update({ sessionIds: event.target.checked ? 'all' : [] })} />授权工作区内的全部会话</label>
        {value.sessionIds !== 'all' && <label>会话 id，每行一个<textarea rows={2} value={value.sessionIds.join('\n')} onChange={event => update({ sessionIds: event.target.value.split('\n') })} /></label>}
      </>}
      <label><input type="checkbox" checked={value.allowUi} disabled={value.workspaces !== 'all' || value.sessionSync !== 'content' || value.sessionIds !== 'all'} onChange={event => update({ allowUi: event.target.checked })} />允许打开完整远端界面</label>
      <small>完整界面包含终端、浏览器和文件操作，需要全部工作区与全部会话内容授权。委派会在选定工作区启动，并使用执行设备的权限预设与沙箱。</small>
    </fieldset>
  }
  function cleanScope(scope: Scope): Scope {
    return { ...scope, workspaces: scope.workspaces === 'all' ? 'all' : scope.workspaces.map(value => value.trim()).filter(Boolean), sessionIds: scope.sessionIds === 'all' ? 'all' : scope.sessionIds.map(value => value.trim()).filter(Boolean) }
  }
  function TrustedCard({ device, changed }: { device: DeviceState['trusted'][number]; changed(): void }) {
    const [scope, setScope] = useState(device.scope)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => setScope(device.scope), [JSON.stringify(device.scope)])
    async function save(revoke = false) {
      setBusy(true); setError('')
      try {
        await api(revoke ? 'revoke' : 'scope', { deviceId: device.deviceId, side: 'trusted', scope: cleanScope(scope) })
        changed()
      } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
    }
    return <article><h4>{device.name}</h4><small>{device.deviceId} · {device.relationship === 'same-account' ? '已确认同账号' : device.relationship === 'different-account' ? '不同账号' : '账号关系待确认'}</small>
      <details><summary>修改授权</summary><ScopeFields value={scope} onChange={setScope} /><div className="dl-actions"><button disabled={busy} onClick={() => void save()}>保存范围</button><button disabled={busy} onClick={() => void save(true)}>撤销授权</button></div></details>
      {error && <p role="alert" className="dl-error">{error}</p>}
    </article>
  }
  function PeerCard({ peer, changed }: { peer: PeerView; changed(): void }) {
    const [workspace, setWorkspace] = useState(peer.status?.host.workspaces[0]?.path ?? '')
    const [task, setTask] = useState('')
    const [result, setResult] = useState<DelegateResult | null>(null)
    const [content, setContent] = useState<{ session: SessionContent; cachedAt: string } | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => { if (!workspace) setWorkspace(peer.status?.host.workspaces[0]?.path ?? '') }, [peer.status, workspace])
    async function run(operation: () => Promise<void>) {
      setBusy(true); setError('')
      try { await operation() } catch (cause) { setError(message(cause)) } finally { setBusy(false); changed() }
    }
    async function open() {
      const tab = window.open('about:blank', '_blank')
      if (tab) tab.opener = null
      await run(async () => {
        try {
          const access = await api<{ url: string }>('open', { deviceId: peer.deviceId })
          if (!tab) throw new Error('浏览器拦截了新窗口，请允许弹窗后重试')
          tab.location.href = access.url
        } catch (cause) { tab?.close(); throw cause }
      })
    }
    return <article>
      <div className="dl-row"><h4><span className={peer.online ? 'dl-online' : 'dl-offline'}>●</span> {peer.name}</h4><span>{peer.online ? '在线' : '离线'}</span></div>
      <small>{peer.baseUrl} · {peer.status?.host.platform} · 插件 {peer.status?.device.version ?? '未知'}</small>
      {peer.update === 'remote-older' && <p>远端插件版本较旧，可在该设备更新插件。</p>}
      {peer.update === 'remote-newer' && <p>远端插件版本较新，可更新本机插件。</p>}
      {peer.cachedAt && <small className="dl-block">缓存于 {new Date(peer.cachedAt).toLocaleString()} · {peer.cachedSessionIds.length} 个会话正文</small>}
      {!peer.online && peer.probeError && <p className="dl-muted">{peer.probeError}</p>}
      <div className="dl-actions">
        <button disabled={busy || !peer.online || !peer.status?.scope.allowUi} onClick={() => void open()}>打开界面</button>
        <button disabled={busy} onClick={() => void run(async () => { await api('sync', { deviceId: peer.deviceId }) })}>同步会话</button>
        <button disabled={busy} onClick={() => void run(async () => { const result = await api<{ remoteRevoked: boolean }>('revoke', { deviceId: peer.deviceId }); if (!result.remoteRevoked) window.alert('本地连接与缓存已删除。对端当前不可达，请在对端撤销该设备授权。') })}>断开</button>
      </div>
      <details><summary>工作区与任务委派</summary>
        {(peer.status?.host.workspaces ?? []).map(item => <p className="dl-path" key={item.id}>{item.path}</p>)}
        <label>执行工作区<input value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
        <label>任务<textarea rows={3} value={task} onChange={event => setTask(event.target.value)} /></label>
        <button disabled={busy || !peer.online || !peer.status?.scope.allowDelegate || !workspace || !task.trim()} onClick={() => void run(async () => { setResult(await api<DelegateResult>('delegate', { deviceId: peer.deviceId, workspacePath: workspace, task })) })}>{busy ? '处理中…' : '委派任务'}</button>
        {result && <pre>{result.status} · {result.sessionId}{'\n'}{result.error || result.text}</pre>}
      </details>
      <details><summary>智能体与会话</summary>
        {(peer.status?.host.agents ?? []).map(agent => <p key={agent.id}>{agent.id} · {agent.status} · {agent.provider}/{agent.model}</p>)}
        {(peer.status?.host.sessions ?? []).map(session => <div className="dl-row" key={session.id}><span>{session.title}<small className="dl-block">{session.cwd}</small></span>
          <button disabled={busy || !peer.cachedSessionIds.includes(session.id)} onClick={() => void run(async () => { setContent(await api('session', { deviceId: peer.deviceId, sessionId: session.id })) })}>查看缓存</button></div>)}
        {content && <div><small>缓存于 {new Date(content.cachedAt).toLocaleString()}{content.session.truncated ? ' · 内容已截断' : ''}</small><pre>{content.session.messages.map(item => `${item.role}\n${item.text}`).join('\n\n')}</pre></div>}
      </details>
      {error && <p role="alert" className="dl-error">{error}</p>}
    </article>
  }
  function DeviceLinkPage() {
    const [state, setState] = useState<DeviceState | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [address, setAddress] = useState('')
    const [code, setCode] = useState('')
    const [relation, setRelation] = useState<AccountRelation>('unknown')
    const [scope, setScope] = useState<Scope>(defaultScope())
    const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null)
    const [now, setNow] = useState(Date.now())
    const refresh = useCallback(async () => { try { setState(await api<DeviceState>('state')) } catch (cause) { setError(message(cause)) } }, [])
    useEffect(() => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      async function poll() {
        try { const next = await api<DeviceState>('state', undefined, controller.signal); if (!controller.signal.aborted) setState(next) } catch (cause) { if (!controller.signal.aborted) setError(message(cause)) }
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 10_000)
      }
      void poll()
      const ticker = setInterval(() => setNow(Date.now()), 1000)
      return () => { controller.abort(); clearTimeout(timer); clearInterval(ticker) }
    }, [])
    async function run(operation: () => Promise<unknown>) {
      setBusy(true); setError('')
      try { await operation(); await refresh() } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
    }
    const remaining = state?.pairing ? Math.max(0, Math.ceil((Date.parse(state.pairing.expiresAt) - now) / 1000)) : 0
    return <div className="dl-page">
      <style>{`
        .dl-page{max-width:820px;color:var(--dsw-alias-label-primary);padding:4px 0 32px;font-size:14px;line-height:1.55}
        .dl-page h2{font-size:22px;margin:0 0 16px}.dl-page h3{font-size:16px;margin:0 0 12px}.dl-page h4{margin:4px 0;font-size:14px}
        .dl-page section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px;margin-bottom:16px;background:var(--dsw-alias-bg-layer-1)}
        .dl-page article+article{border-top:1px solid var(--dsw-alias-border-l1);margin-top:16px;padding-top:12px}
        .dl-page label{display:block;margin:10px 0}.dl-page input:not([type=checkbox]),.dl-page textarea,.dl-page select{display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-layer-2);font:inherit}
        .dl-page input[type=checkbox]{margin-right:8px}.dl-page button{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer;font:inherit}.dl-page button:disabled{opacity:.45;cursor:default}
        .dl-page button:focus-visible,.dl-page input:focus-visible,.dl-page select:focus-visible,.dl-page textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
        .dl-actions,.dl-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}.dl-row{justify-content:space-between}
        .dl-page small,.dl-muted{color:var(--dsw-alias-label-secondary)}.dl-block{display:block}.dl-error{color:var(--dsw-alias-state-error-primary)}.dl-online{color:var(--dsw-alias-state-success-primary)}.dl-offline{color:var(--dsw-alias-label-secondary)}
        .dl-scope{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;margin:12px 0;padding:10px}.dl-page summary{cursor:pointer;padding:8px 0}.dl-page pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:12px;background:var(--dsw-alias-bg-layer-2);border-radius:6px}.dl-path{overflow-wrap:anywhere}.dl-code{font-size:30px;letter-spacing:5px;font-family:monospace}
      `}</style>
      <h2>设备连接</h2>
      {error && <p role="alert" className="dl-error">{error}</p>}
      <section><h3>连接本机</h3>
        <label><input type="checkbox" checked={state?.allowIncoming ?? false} disabled={busy || !state} onChange={event => void run(() => api('toggle', { allowIncoming: event.target.checked }))} />允许局域网设备连接</label>
        <p className="dl-path">{state?.identity.name} · {state?.listen ? `${state.listen.host}:${state.listen.port}` : '正在启动监听…'}</p>
        {state?.listen?.host.startsWith('127.') && <p>当前监听回环地址。连接另一台电脑时，将 bindAddress 设置为本机局域网 IPv4。</p>}
        <label>首次配对的账号关系<select value={relation} onChange={event => { const next = event.target.value as AccountRelation; setRelation(next); setScope(defaultScope(next === 'same-account')) }}>
          <option value="unknown">待确认</option><option value="same-account">我已确认使用同一账号</option><option value="different-account">使用不同账号</option>
        </select></label>
        <small>由本机所有者确认关系，配对码绑定下面的授权范围。</small>
        <ScopeFields value={scope} onChange={setScope} />
        <button disabled={busy || !state?.allowIncoming} onClick={() => void run(() => api('allow', { relationship: relation, scope: cleanScope(scope) }))}>生成配对码</button>
        {state?.pairing && remaining > 0 && <div><p className="dl-code">{state.pairing.code}</p><p>{remaining} 秒后过期 · 单次使用 · 修改范围后重新生成</p><button disabled={busy} onClick={() => void run(() => api('close-pairing', {}))}>关闭配对码</button></div>}
      </section>
      <section><h3>添加设备</h3><label>设备地址<input placeholder="192.168.1.5:47654" value={address} onChange={event => setAddress(event.target.value)} /></label>
        <label>配对码<input inputMode="numeric" maxLength={8} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /></label>
        <div className="dl-actions"><button disabled={busy || !address || code.length !== 8} onClick={() => void run(async () => { await api('pair', { address, code }); setCode('') })}>添加设备</button>
          <button disabled={busy || !address} onClick={() => void run(async () => { const result = await api<{ diagnostic: Diagnostic }>('diagnose', { address }); setDiagnostic(result.diagnostic) })}>诊断连接</button></div>
        {diagnostic && <div role="status"><p>{diagnostic.message} · {diagnostic.elapsedMs} ms</p>{diagnostic.interfaces.map(item => <small className="dl-block" key={item.address}>{item.name} · {item.address}</small>)}</div>}
      </section>
      <section><h3>已连接设备</h3>{state?.peers.length ? state.peers.map(peer => <PeerCard key={peer.deviceId} peer={peer} changed={() => void refresh()} />) : <p className="dl-muted">尚未连接设备。</p>}</section>
      <section><h3>已授权连接本机的设备</h3>{state?.trusted.length ? state.trusted.map(device => <TrustedCard key={device.deviceId} device={device} changed={() => void refresh()} />) : <p className="dl-muted">尚未授权设备。</p>}</section>
    </div>
  }
  return { inject: ['slots', 'inputTriggers'], apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'device-link', order: 16, label: '设备连接' }, DeviceLinkPage))
    ctx.effect(() => ctx.inputTriggers.registerSource({
      trigger: '@', name: '设备工作区与缓存会话', order: 30,
      async candidates(_session, request) {
        const state = await api<{ peers: PeerView[] }>('references', undefined, request.signal)
        const candidates: Candidate[] = []
        for (const peer of state.peers) {
          for (const workspace of peer.status?.host.workspaces ?? []) {
            const value = `device://${peer.deviceId}/workspace?path=${encodeURIComponent(workspace.path)}`
            candidates.push({ name: `${peer.name}:${workspace.path}`, label: `${peer.name} · ${workspace.title}`, description: peer.online ? workspace.path : `离线缓存 · ${workspace.path}`, value, icon: 'folder' })
          }
          for (const session of peer.status?.host.sessions ?? []) {
            if (!peer.cachedSessionIds.includes(session.id)) continue
            candidates.push({ name: `${peer.name}:${session.id}`, label: `${peer.name} · ${session.title}`, description: `会话缓存 · ${peer.cachedAt}`, value: `device://${peer.deviceId}/session?id=${encodeURIComponent(session.id)}`, icon: 'session' })
          }
        }
        const query = request.query.toLowerCase()
        return candidates.filter(item => `${item.name} ${item.label}`.toLowerCase().includes(query)).slice(0, 40)
      },
      onPick({ candidate }) { return { text: `@${candidate.value} ` } },
    }))
  } }
} })
