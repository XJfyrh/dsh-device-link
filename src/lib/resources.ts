import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import type { HostContext } from './host.js'
import { authorizedWorkspace, isPathAllowed, sessionAllowed } from './scope.js'
import { evidenceEvent, revisionOf } from './evidence.js'
import { HttpError, type EvidenceEvent, type Scope, type CachedSession } from './types.js'

export interface ResourceTarget { kind: 'workspace' | 'session'; workspacePath: string; sessionId?: string }
export interface ResourceRequest extends ResourceTarget {
  action: 'inspect' | 'search' | 'read'
  query?: string
  path?: string
  seq?: number
  revision?: string
  startLine?: number
  offset?: number
}
export interface ResourceItem {
  title: string; path?: string; seq?: number; type?: string; time?: number
  revision?: string; startLine?: number; endLine?: number; text?: string; offset?: number; nextOffset?: number; nextLine?: number
  truncated?: boolean
}
export interface ResourceResult {
  action: ResourceRequest['action']; source: 'device' | 'cache'; observedAt: string
  items: ResourceItem[]; coverage: string; truncated: boolean
}
const ignored = new Set(['.git', 'node_modules', '.env', '.dsh', '.ssh', '.aws', 'dist', '.next'])
const excluded = (name: string) => ignored.has(name) || name.startsWith('.env.') && name !== '.env.example'
const integer = (value: unknown, fallback: number, minimum = 0) => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new HttpError(400, 'invalid read position')
  return Number(value)
}
export function validateResourceRequest(input: ResourceRequest): void {
  if (!['workspace', 'session'].includes(input.kind) || !['inspect', 'search', 'read'].includes(input.action)
    || typeof input.workspacePath !== 'string' || !input.workspacePath) throw new HttpError(400, 'invalid resource request')
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 4096 || input.path.includes('\0'))) throw new HttpError(400, 'invalid relative path')
  if (input.kind === 'session' && (typeof input.sessionId !== 'string' || !input.sessionId)) throw new HttpError(400, 'session required')
  if (input.action === 'search' && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200)) throw new HttpError(400, 'query must contain 1–200 characters')
  if (input.action === 'read' && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))) throw new HttpError(400, 'read requires the revision from inspect or search')
  if (input.action === 'read' && input.kind === 'session' && (!Number.isSafeInteger(input.seq) || input.seq! < 0)) throw new HttpError(400, 'event sequence required')
}
const matches = (text: string, query: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
function eventItem(event: EvidenceEvent, full = false, offset = 0): ResourceItem {
  const end = Math.min(event.text.length, offset + (full ? 12_000 : 300))
  return { title: event.type === 'user/message' ? '用户消息' : event.type === 'assistant/message' ? '智能体回复' : event.type === 'tool/call' ? '工具调用' : '工具结果',
    seq: event.seq, type: event.type, time: event.time, revision: event.revision, text: event.text.slice(offset, end), offset,
    ...(full && end < event.text.length ? { nextOffset: end } : {}), truncated: event.truncated || end < event.text.length }
}
export function queryEvidence(events: EvidenceEvent[], input: ResourceRequest, source: 'device' | 'cache', observedAt: string, incomplete: boolean): ResourceResult {
  validateResourceRequest(input)
  if (input.action === 'read') {
    const seq = integer(input.seq, -1)
    const target = events.find(event => event.seq === seq)
    if (!target) throw new HttpError(404, source === 'cache' ? '该事件未缓存在本机' : 'event unavailable')
    if (target.revision !== input.revision) throw new HttpError(409, '事件内容已变化，请重新搜索')
    const offset = integer(input.offset, 0)
    if (offset > target.text.length) throw new HttpError(400, 'offset exceeds available content')
    return { action: input.action, source, observedAt, items: [eventItem(target, true, offset)], truncated: target.truncated,
      coverage: `${source === 'cache' ? '已缓存' : '已授权'}事件原文；工具结果描述当时执行情况，不代表当前文件版本` }
  }
  const selected = input.action === 'search' ? events.filter(event => matches(event.text, input.query!)) : events.slice(-20)
  return { action: input.action, source, observedAt, items: selected.slice(0, 20).map(event => {
    const offset = input.action === 'search' ? Math.max(0, event.text.toLocaleLowerCase().indexOf(input.query!.trim().toLocaleLowerCase()) - 80) : 0
    return eventItem(event, false, offset)
  }), truncated: incomplete || selected.length > 20,
  coverage: `${source === 'cache' ? '仅本机已缓存' : '已授权'}的对话文本${events.some(event => event.type.startsWith('tool/')) ? '与工具记录' : ''}；${incomplete ? '内容不完整，未命中不代表全部历史中不存在' : '最多返回 20 条，更多结果请缩小查询'}` }
}
export function queryCachedSession(session: CachedSession, input: ResourceRequest, tools: boolean): ResourceResult {
  const events = (session.evidence ?? session.messages.map((message, i) => ({ seq: message.seq ?? i, type: `${message.role}/message`, text: message.text, revision: revisionOf(message.text), time: message.timestamp, truncated: session.truncated })))
    .filter(event => tools || !event.type.startsWith('tool/'))
  return queryEvidence(events, input, 'cache', session.cachedAt, session.evidenceTruncated ?? session.truncated)
}

/** Reads beneath the authorized real root; directory links and sensitive config names are not traversed. */
async function readFile(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some(part => part === '..' || excluded(part))) throw new HttpError(403, '文件不在可读取范围内')
  const filename = path.resolve(root, relative)
  if (!isPathAllowed(filename, [root])) throw new HttpError(403, 'file outside workspace')
  let cursor = root
  for (const part of path.relative(root, filename).split(path.sep)) {
    cursor = path.join(cursor, part)
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new HttpError(403, '不读取符号链接文件或目录')
  }
  const real = await fs.realpath(filename)
  if (!isPathAllowed(real, [root])) throw new HttpError(403, 'file resolves outside workspace')
  const file = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 512_000) throw new HttpError(413, '仅支持读取 512 KB 以内的文本文件')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, 512_001))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 512_000) throw new HttpError(413, '文件过大')
    const content = bytes.subarray(0, bytesRead)
    if (content.includes(0)) throw new HttpError(415, '不读取二进制文件')
    const after = await file.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await fs.realpath(filename) !== real) throw new HttpError(409, '文件读取期间发生变化')
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), revision: revisionOf(content) }
  } finally { await file.close() }
}
async function workspaceQuery(input: ResourceRequest, scope: Scope): Promise<ResourceResult> {
  if (!scope.allowReadFiles) throw new HttpError(403, '设备未授权读取工作区文件', 'scope')
  const root = await authorizedWorkspace(input.workspacePath, scope)
  const result: ResourceResult = { action: input.action, source: 'device', observedAt: new Date().toISOString(), items: [], truncated: false,
    coverage: '当前工作区的 UTF-8 文本文件（每个不超过 512 KB）；跳过符号链接、依赖、构建目录和 .env 等配置；不是历史版本' }
  if (input.action === 'read') {
    const relative = String(input.path ?? '')
    const file = await readFile(root, relative)
    if (file.revision !== input.revision) throw new HttpError(409, '文件已变化，请重新搜索后读取')
    const lines = file.text.split('\n')
    const start = integer(input.startLine, 1, 1)
    if (start > lines.length) throw new HttpError(400, 'line exceeds file')
    let end = start; let text = ''
    while (end <= lines.length && end < start + 120) {
      const line = lines[end - 1]
      if (text.length + line.length > 16_000) { if (!text) throw new HttpError(413, '单行内容过长，无法按行读取'); break }
      text += (text ? '\n' : '') + line; end++
    }
    result.items = [{ title: relative, path: relative, revision: file.revision, text, startLine: start, endLine: end - 1, ...(end <= lines.length ? { nextLine: end } : {}) }]
    return result
  }
  const directory = input.path ?? ''
  if (path.isAbsolute(directory) || directory.split(/[\\/]/).some(part => part === '..' || excluded(part)) || !isPathAllowed(path.resolve(root, directory), [root])) throw new HttpError(403, '目录不在工作区内')
  let currentDirectory = root
  for (const part of directory.split(/[\\/]/).filter(Boolean)) {
    currentDirectory = path.join(currentDirectory, part)
    if ((await fs.lstat(currentDirectory)).isSymbolicLink()) throw new HttpError(403, '不遍历符号链接目录')
  }
  const queue = [directory]; let scanned = 0; let skipped = 0
  while (queue.length && scanned < 1500 && result.items.length < 20) {
    const dir = queue.shift()!
    const location = path.join(root, dir)
    if (await fs.realpath(location) !== location) { skipped++; continue }
    const entries = await fs.readdir(location, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++scanned > 1500 || result.items.length >= 20) { result.truncated = true; break }
      if (entry.isSymbolicLink() || excluded(entry.name)) { skipped++; continue }
      const relative = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (input.action === 'search') queue.push(relative); else result.items.push({ title: entry.name + '/', path: relative }); continue }
      if (!entry.isFile()) continue
      try {
        const file = await readFile(root, relative)
        if (input.action === 'inspect') { result.items.push({ title: entry.name, path: relative, revision: file.revision }); continue }
        const lines = file.text.split('\n')
        const line = lines.findIndex(text => matches(text, input.query!))
        if (line >= 0 || matches(relative, input.query!)) result.items.push({ title: relative, path: relative, revision: file.revision, startLine: Math.max(1, line + 1), text: (lines[Math.max(0, line)] ?? '').slice(0, 300) })
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) throw error
        skipped++
      }
    }
  }
  result.truncated ||= queue.length > 0 || scanned >= 1500
  result.coverage += `；检查 ${scanned} 个条目，跳过 ${skipped} 项${result.truncated ? '；已达扫描或结果上限，请缩小范围' : ''}`
  return result
}
export function createResourceProvider(ctx: Pick<HostContext, 'get'>) {
  return async (input: ResourceRequest, scope: Scope): Promise<ResourceResult> => {
    validateResourceRequest(input)
    if (input.kind === 'workspace') return workspaceQuery(input, scope)
    if (scope.sessionSync !== 'content' || !sessionAllowed({ id: input.sessionId!, cwd: input.workspacePath }, scope)) throw new HttpError(403, '会话正文未授权', 'scope')
    const query = ctx.get('sessionQuery')
    if (!query?.filterEvents || !query.readEvent) throw new HttpError(503, '当前 DSH 未提供会话查询服务')
    const snapshot = await query.readSession(input.sessionId!)
    if (snapshot.session.cwd !== input.workspacePath) throw new HttpError(403, '会话工作区已变化', 'scope')
    let events = snapshot.events
    if (input.action === 'search') {
      const hits = await query.filterEvents(input.sessionId!, [{ kind: 'text', text: input.query! }])
      const seqs = new Set(hits.map(hit => hit.seq))
      events = events.filter(event => seqs.has(event.seq))
    } else if (input.action === 'read') {
      const read = await query.readEvent({ sessionId: input.sessionId!, seq: integer(input.seq, -1) })
      if (read.session.cwd !== input.workspacePath) throw new HttpError(403, '会话工作区已变化', 'scope')
      events = [read.target]
    }
    const evidence = events.map(event => evidenceEvent(event, scope.sessionTools === true, Infinity)).filter((event): event is EvidenceEvent => Boolean(event))
    return queryEvidence(evidence, input, 'device', new Date().toISOString(), evidence.some(event => event.truncated))
  }
}
