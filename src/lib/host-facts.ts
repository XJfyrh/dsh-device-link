import os from 'node:os'
import type { HostContext, HostEvent } from './host.js'
import { isPathAllowed, sessionAllowed } from './scope.js'
import { readableTitle } from './presentation.js'
import { parseSelection } from './models.js'
import { cacheEvidence } from './evidence.js'
import { type Scope, type HostFacts, type SessionContent, type SessionFact, type SessionMessage, record, HttpError } from './types.js'

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => record(block)).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

export async function collectHostFacts(ctx: Pick<HostContext, 'get'>, { scope, startedAt = Date.now() }: { scope?: Scope; startedAt?: number } = {}): Promise<HostFacts> {
  const workspaces = (ctx.get('workspaceRegistry')?.list() ?? [])
    .filter(item => isPathAllowed(item.path, scope?.workspaces))
    .map(item => ({ id: item.id, path: item.path, title: item.title }))
  const live = ctx.get('sessions')?.list() ?? []
  const sessions = new Map<string, SessionFact>()
  const controller = ctx.get('sessionController')
  if (controller && scope?.sessionSync !== 'none') {
    // The host list reads persisted projections, never folds every archived log.
    const { items } = await controller.list({}, AbortSignal.timeout(4000))
    for (const item of items) {
      const fact = { id: item.sessionId, cwd: item.cwd ?? '', live: item.agentAvailable,
        updatedAt: item.updatedAt, title: readableTitle({ id: item.sessionId, title: item.projections?.values.title ?? '' }) }
      if (!scope || sessionAllowed(fact, scope)) sessions.set(fact.id, fact)
    }
  }
  for (const session of controller ? [] : live) {
    if (scope && !sessionAllowed({ id: session.id, cwd: session.header.cwd ?? '' }, scope)) continue
    sessions.set(session.id, sessionFact(session.id, session.header.cwd ?? '', session.snapshotEvents(), true, timestamp(session.updatedAt ?? session.header.createdAt), session.title))
  }
  const agents = (ctx.get('agents')?.list() ?? [])
    .filter(agent => isPathAllowed(agent.session.header.cwd, scope?.workspaces) && (!scope || sessionAllowed({ id: agent.id, cwd: agent.session.header.cwd ?? '' }, scope)))
    .map(agent => ({ id: agent.id, title: sessions.get(agent.id)?.title ?? '新会话', cwd: agent.session.header.cwd ?? '', status: agent.status, model: agent.options.model, provider: agent.options.provider }))
  return {
    platform: process.platform, arch: process.arch, hostname: os.hostname(), node: process.version, startedAt,
    workspaces, sessions: [...sessions.values()].filter(session => !scope || sessionAllowed(session, scope)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200),
    agents, model: ctx.get('agentDefaultModel')?.currentSelection() ?? {},
  }
}

function sessionFact(id: string, cwd: string, events: HostEvent[], live: boolean, created: number, title = ''): SessionFact {
  const named = [...events].reverse().find(event => event.type === 'session/title' && typeof event.data.title === 'string')
  return { id, cwd, live, title: readableTitle({ id, title: named ? String(named.data.title) : title }, eventMessages(events)),
    updatedAt: Math.max(created, ...events.filter(event => event.type === 'user/message' || event.type === 'assistant/message').map(event => event.time ?? 0)) }
}
export function eventMessages(events: HostEvent[]): SessionMessage[] {
  let turn: number | undefined
  let selection: SessionMessage['selection']
  const requests = new Map<number, string>()
  const messages: SessionMessage[] = []
  for (const event of events) {
    if (event.type === 'turn/start') turn = typeof event.data.turn === 'number' ? event.data.turn : undefined
    if (event.type === 'request/header') selection = parseSelection(record(event.data.header).config)
    const currentTurn = typeof event.data.turn === 'number' ? event.data.turn : turn
    const source = record(event.data.source)
    if (event.type === 'user/message' && source.kind === 'user') {
      if (currentTurn !== undefined && typeof source.rpcId === 'string') requests.set(currentTurn, source.rpcId)
      messages.push({ role: 'user', text: contentText(event.data.content), seq: event.seq, turn: currentTurn, timestamp: event.time })
    }
    if (event.type === 'assistant/message') messages.push({ role: 'assistant', text: contentText(record(event.data.message).content), seq: event.seq, turn: currentTurn, timestamp: event.time, selection })
  }
  return messages.map(message => ({ ...message, requestId: message.turn === undefined ? undefined : requests.get(message.turn) }))
}

export async function readSessionContent(ctx: Pick<HostContext, 'get'>, id: string, scope: Scope): Promise<SessionContent> {
  if (scope.sessionSync !== 'content') throw new HttpError(403, 'session content sync is disabled', 'scope')
  let fact: SessionFact
  let events: HostEvent[]
  const live = ctx.get('sessions')?.get(id)
  if (live) {
    if (!sessionAllowed({ id, cwd: live.header.cwd ?? '' }, scope)) throw new HttpError(403, 'session scope changed', 'scope')
    events = live.snapshotEvents()
    fact = sessionFact(id, live.header.cwd ?? '', events, true, timestamp(live.updatedAt ?? live.header.createdAt), live.title)
  } else {
    const query = ctx.get('sessionQuery')
    if (!query) throw new HttpError(503, 'session history service unavailable')
    const snapshot = await query.readSession(id).catch(error => {
      if (record(error).code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw new HttpError(404, 'session is unavailable')
      throw error
    })
    if (!sessionAllowed({ id, cwd: snapshot.session.cwd ?? '' }, scope)) throw new HttpError(403, 'session scope changed', 'scope')
    events = snapshot.events
    fact = sessionFact(id, snapshot.session.cwd ?? '', events, false, timestamp(snapshot.session.createdAt))
  }
  const messages = eventMessages(events).filter(message => message.text.trim())
  let remaining = 64_000
  const bounded: SessionMessage[] = []
  for (const message of messages.slice(-100).reverse()) {
    if (!remaining) break
    const text = message.text.slice(-remaining)
    remaining -= text.length
    bounded.unshift({ ...message, text })
  }
  return { ...fact, messages: bounded, truncated: bounded.length < messages.length || messages.reduce((n, message) => n + message.text.length, 0) > 64_000,
    ...cacheEvidence(events, scope.sessionTools === true) }
}
