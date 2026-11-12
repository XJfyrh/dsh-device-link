import type { SessionFact, SessionMessage } from './types.js'

export function shortText(text: string, limit = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}
export function readableTitle(session: Pick<SessionFact, 'id' | 'title'>, messages: SessionMessage[] = []): string {
  if (session.title.trim() && session.title !== session.id && !/^(session|delegate)-[\da-f-]{20,}$/i.test(session.title)) return session.title
  return shortText(messages.find(message => message.role === 'user')?.text ?? '') || '新会话'
}
export function workspaceName(path = ''): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '工作区' }
export function relativeTime(value?: number | string | null): string {
  const date = typeof value === 'number' ? value : Date.parse(value ?? '')
  if (!date || !Number.isFinite(date)) return '尚未同步'
  const minutes = Math.max(0, Math.floor((Date.now() - date) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return new Date(date).toLocaleDateString()
}
