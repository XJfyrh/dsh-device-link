import type * as ReactTypes from 'react'
import type { Scope, WorkspaceFact, SessionFact } from '../lib/types.js'
import type { DeviceState } from '../lib/api.js'
import { api, message } from './state.js'
import type { createChoiceField } from './choice-field.js'
import type { ClientPrimitives } from './contracts.js'

export function createScopeComponents(React: typeof ReactTypes, ChoiceField: ReturnType<typeof createChoiceField>, primitives: ClientPrimitives) {
  const { useState, useEffect } = React
  const { IconChevronRightOutlineRegular: ChevronIcon } = primitives
  function ScopeFields({ value, onChange, workspaces = [], sessions = [] }: { value: Scope; onChange(value: Scope): void; workspaces?: WorkspaceFact[]; sessions?: SessionFact[] }) {
    function update(next: Partial<Scope>) {
      const merged = { ...value, ...next }
      if (merged.workspaces !== 'all' || merged.sessionSync !== 'content' || merged.sessionIds !== 'all') merged.allowUi = false
      onChange(merged)
    }
    return <fieldset className="dl-scope">
      <legend>授权范围</legend>
      <label><input type="checkbox" checked={value.workspaces === 'all'} onChange={event => update({ workspaces: event.target.checked ? 'all' : [] })} />全部工作区</label>
      {value.workspaces !== 'all' && <>{workspaces.map(workspace => <label key={workspace.path} title={workspace.path}><input type="checkbox" checked={value.workspaces.includes(workspace.path)} onChange={event => update({ workspaces: event.target.checked ? [...value.workspaces as string[], workspace.path] : (value.workspaces as string[]).filter(path => path !== workspace.path) })} />{workspace.title}</label>)}
        <details><summary className="dl-disclosure-summary"><ChevronIcon size={14} />添加其他目录</summary><label>工作区绝对路径，每行一个<textarea rows={3} value={value.workspaces.join('\n')} placeholder="E:\project" onChange={event => update({ workspaces: event.target.value.split('\n') })} /></label></details></>}
      <label><input type="checkbox" checked={value.allowDelegate} onChange={event => update({ allowDelegate: event.target.checked })} />允许委派任务</label>
      <label><input type="checkbox" checked={value.allowReadFiles === true} onChange={event => update({ allowReadFiles: event.target.checked })} />允许搜索和读取工作区文件</label>
      <ChoiceField<Scope['sessionSync']> label="会话同步" value={value.sessionSync} onChange={sessionSync => update({ sessionSync })} options={[
        { value: 'none', label: '关闭' }, { value: 'metadata', label: '会话目录' }, { value: 'content', label: '目录与对话正文' },
      ]} />
      {value.sessionSync !== 'none' && <>
        {value.sessionSync === 'content' && <label><input type="checkbox" checked={value.sessionTools === true} onChange={event => update({ sessionTools: event.target.checked })} />共享会话中的工具调用与结果</label>}
        <label><input type="checkbox" checked={value.sessionIds === 'all'} onChange={event => update({ sessionIds: event.target.checked ? 'all' : [] })} />授权工作区内的全部会话</label>
        {value.sessionIds !== 'all' && <>{sessions.filter(session => value.workspaces === 'all' || value.workspaces.some(path => session.cwd === path || session.cwd.startsWith(path.replace(/[\\/]$/, '') + (path.includes('\\') ? '\\' : '/')))).map(session => <label key={session.id}><input type="checkbox" checked={value.sessionIds.includes(session.id)} onChange={event => update({ sessionIds: event.target.checked ? [...value.sessionIds as string[], session.id] : (value.sessionIds as string[]).filter(id => id !== session.id) })} />{session.title}</label>)}{!sessions.length && <small>本机暂无可选择的会话</small>}</>}
      </>}
      <label><input type="checkbox" checked={value.allowUi} disabled={value.workspaces !== 'all' || value.sessionSync !== 'content' || value.sessionIds !== 'all'} onChange={event => update({ allowUi: event.target.checked })} />允许打开本机完整界面</label>
      <small>完整界面包含终端、浏览器和文件操作，需要全部工作区与全部会话内容授权。委派会在选定工作区启动，并使用执行设备的权限预设与沙箱。</small>
    </fieldset>
  }
  function cleanScope(scope: Scope): Scope {
    return { ...scope, workspaces: scope.workspaces === 'all' ? 'all' : scope.workspaces.map(value => value.trim()).filter(Boolean), sessionIds: scope.sessionIds === 'all' ? 'all' : scope.sessionIds.map(value => value.trim()).filter(Boolean) }
  }
  function TrustedCard({ device, changed, workspaces, sessions }: { device: DeviceState['trusted'][number]; changed(): void; workspaces?: WorkspaceFact[]; sessions?: SessionFact[] }) {
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
    return <article><h4>{device.name}</h4><small>{device.relationship === 'same-account' ? '已确认同账号' : device.relationship === 'different-account' ? '不同账号' : '账号关系待确认'}</small>
      <dl className="dl-facts"><dt>工作区</dt><dd>{device.scope.workspaces === 'all' ? '全部工作区' : `${device.scope.workspaces.length} 个工作区`}</dd><dt>执行任务</dt><dd>{device.scope.allowDelegate ? '允许' : '不允许'}</dd><dt>会话共享</dt><dd>{device.scope.sessionSync === 'content' ? '同步正文' : device.scope.sessionSync === 'metadata' ? '同步目录' : '不共享'}</dd></dl>
      <details><summary className="dl-disclosure-summary"><ChevronIcon size={14} />修改授权</summary><ScopeFields value={scope} onChange={setScope} workspaces={workspaces} sessions={sessions} /><div className="dl-actions"><button disabled={busy} onClick={() => void save()}>保存范围</button><button disabled={busy} onClick={() => void save(true)}>撤销授权</button></div></details>
      {error && <p role="alert" className="dl-error">{error}</p>}
    </article>
  }
  return { ScopeFields, TrustedCard, cleanScope }
}
