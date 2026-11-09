import os from 'node:os'
import { service, type HostContext, type HostEvent, type HostMessage } from './host.js'
import { isPathAllowed, sessionAllowed } from './scope.js'
import { type Scope, type HostFacts, type SessionContent, type SessionFact, type SessionMessage, record, HttpError } from './types.js'
export { isPathAllowed } from './scope.js'

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => record(block)).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

export function lastAssistantText(messages: HostMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role === 'assistant') {
      const text = contentText(message.content)
      if (text) return text
    }
  }
  return ''
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

export async function collectHostFacts(ctx: Pick<HostContext, 'get'>, { scope, startedAt = Date.now() }: { scope?: Scope; startedAt?: number } = {}): Promise<HostFacts> {
  const workspaces = (service(ctx, 'workspaceRegistry')?.list() ?? []).filter(item => isPathAllowed(item.path, scope?.workspaces))
  const live = service(ctx, 'sessions')?.list() ?? []
  const sessions = new Map<string, SessionFact>()
  const query = service(ctx, 'sessionQuery')
  if (query && scope?.sessionSync !== 'none') {
    for (const entry of await query.listSessions()) {
      const header = entry.header
      if (header.id) sessions.set(header.id, { id: header.id, title: header.id, cwd: header.cwd ?? '', updatedAt: timestamp(header.createdAt), live: entry.live })
    }
  }
  for (const session of live) {
    sessions.set(session.id, { id: session.id, title: session.title || session.id, cwd: session.header.cwd ?? '', updatedAt: timestamp(session.updatedAt ?? session.header.createdAt), live: true })
  }
  const agents = (service(ctx, 'agents')?.list() ?? [])
    .filter(agent => isPathAllowed(agent.session.header.cwd, scope?.workspaces) && (!scope || sessionAllowed({ id: agent.id, cwd: agent.session.header.cwd ?? '' }, scope)))
    .map(agent => ({ id: agent.id, cwd: agent.session.header.cwd ?? '', status: agent.status, model: agent.options.model, provider: agent.options.provider }))
  return {
    platform: process.platform, arch: process.arch, hostname: os.hostname(), node: process.version, startedAt,
    workspaces, sessions: [...sessions.values()].filter(session => !scope || sessionAllowed(session, scope)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200),
    agents, model: service(ctx, 'agentDefaultModel')?.currentSelection() ?? {},
  }
}

function eventMessages(events: HostEvent[]): SessionMessage[] {
  return events.flatMap<SessionMessage>(event => {
    if (event.type === 'user/message') return [{ role: 'user' as const, text: contentText(event.data.content) }]
    if (event.type === 'assistant/message') return [{ role: 'assistant' as const, text: contentText(record(event.data.message).content) }]
    return []
  })
}

export async function readSessionContent(ctx: Pick<HostContext, 'get'>, id: string, scope: Scope): Promise<SessionContent> {
  if (scope.sessionSync !== 'content') throw new HttpError(403, 'session content sync is disabled', 'scope')
  const facts = await collectHostFacts(ctx, { scope })
  const fact = facts.sessions.find(session => session.id === id)
  if (!fact) throw new HttpError(404, 'session is unavailable in the granted scope')
  let messages: SessionMessage[]
  const live = service(ctx, 'sessions')?.get(id)
  if (live) {
    if (!sessionAllowed({ id, cwd: live.header.cwd ?? '' }, scope)) throw new HttpError(403, 'session scope changed', 'scope')
    messages = live.deriveMessages().filter(message => message.role === 'user' || message.role === 'assistant')
      .map(message => ({ role: message.role as SessionMessage['role'], text: contentText(message.content) }))
  } else {
    const query = service(ctx, 'sessionQuery')
    if (!query) throw new HttpError(503, 'session history service unavailable')
    const snapshot = await query.readSession(id)
    if (!sessionAllowed({ id, cwd: snapshot.session.cwd ?? '' }, scope)) throw new HttpError(403, 'session scope changed', 'scope')
    messages = eventMessages(snapshot.events)
  }
  // Bound each snapshot and retain the latest text without tool outputs or reasoning blocks.
  let remaining = 64_000
  const bounded: SessionMessage[] = []
  for (const message of messages.slice(-100).reverse()) {
    if (!remaining) break
    const text = message.text.slice(-remaining)
    remaining -= text.length
    bounded.unshift({ role: message.role, text })
  }
  return { ...fact, messages: bounded, truncated: bounded.length < messages.length || messages.reduce((n, message) => n + message.text.length, 0) > 64_000 }
}
