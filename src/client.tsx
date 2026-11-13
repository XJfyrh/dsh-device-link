import { createComponents } from './client/components.js'
import { createClientState, api, SOURCE, parseReference, reference, serializeReference, sentReferenceRule, cacheLabel } from './client/state.js'
import { styles } from './client/styles.js'
import type { Candidate } from './client/contracts.js'
import type { PeerView } from './lib/connect.js'
import { relativeTime } from './lib/presentation.js'
import { createDeviceIcon } from './client/icons.js'

window.__ModuleLoader__.load({ id: 'dsh-device-link', factory(require) {
  const React = require('react')
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  const { createPortal } = require('react-dom')
  return { inject: ['slots', 'inputTriggers', 'sidebarRightTabs', 'sidebarRight', 'layout', 'sessions', 'conversation', 'uiWorkspace', 'uiConversation'], apply(ctx) {
    const state = createClientState(ctx)
    const components = createComponents(React, state, primitives, createPortal)
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-device-link'; style.textContent = styles; document.head.appendChild(style)
      return () => style.remove()
    })
    ctx.effect(() => state.start())
    ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: 'device-link' }, createDeviceIcon(React)))
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'device-link', order: 16, label: '设备连接' }, components.Settings))
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'device-link', order: 20 }, components.Sidebar))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'device-link', order: 40 }, components.Overlay))
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'device-link-tasks' }, components.TasksPage))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'device-link-tasks', label: '设备任务', order: 25 }, components.PanelIcon))
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'device_delegate', inject: sessionId => ({ sessionId }) }, components.ToolCard))
    for (const key of ['device_inspect', 'device_search', 'device_read']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: sessionId => ({ sessionId }) }, components.ResourceToolRow))
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'device-link-preview', kind: 'device-link-preview', patterns: ['dsh-resource://device-link/**'], title(address) {
      return new URL(address).searchParams.get('title') ?? '设备资源'
    } }))
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'device-link-preview', inject: sessionId => ({ sessionId }) }, components.ResourceTab))
    ctx.effect(() => ctx.uiConversation.userText.register(sentReferenceRule))
    ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'device-link-reference' }, components.SentReference))
    ctx.effect(() => ctx.inputTriggers.registerSource({
      trigger: '@', name: SOURCE, order: 30,
      async candidates(_session, request) {
        const state = await api<{ peers: PeerView[] }>('references', undefined, request.signal)
        const candidates: Candidate[] = []
        for (const peer of state.peers) {
          for (const workspace of peer.status?.host.workspaces ?? []) {
            const value = reference({ deviceId: peer.deviceId, workspace: workspace.path, title: workspace.title }).ref
            candidates.push({ name: `${workspace.title}（${peer.name}）`, label: `${workspace.title}（${peer.name}）`, description: `${peer.online ? '工作区' : '离线工作区'}：${workspace.path}`, value, icon: 'folder' })
          }
          for (const session of peer.status?.host.sessions ?? []) {
            if (!peer.cachedSessionIds.includes(session.id)) continue
            candidates.push({ name: `${session.title}（${peer.name}）`, label: `${session.title}（${peer.name}）`, description: `${cacheLabel(peer, session.id)}，更新于 ${relativeTime(session.updatedAt || peer.cachedAt)}`, value: reference({ deviceId: peer.deviceId, sessionId: session.id, title: session.title }).ref, icon: 'session' })
          }
        }
        const query = request.query.toLowerCase()
        return candidates.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query)).slice(0, 40)
      },
      onPick({ candidate }) { return { insert: { source: SOURCE, ref: candidate.value, label: candidate.label, appearance: candidate.icon, clipboardText: `@${candidate.value}` } } },
      codec: { clipboardText: ref => `@${ref}`, serialize: serializeReference },
      openReference(_session, { ref }) { state.preview(parseReference(ref)); return true },
    }))
  } }
} })
