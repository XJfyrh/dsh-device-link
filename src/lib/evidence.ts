import { createHash } from 'node:crypto'
import type { HostEvent } from './host.js'
import { record, type EvidenceEvent } from './types.js'

export const revisionOf = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(record).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}
/** Share conversation text and explicitly authorized tool material, never request headers or reasoning. */
export function evidenceEvent(event: HostEvent, tools: boolean, maxChars = 64_000): EvidenceEvent | undefined {
  let text = ''
  if (event.type === 'user/message' && record(event.data.source).kind === 'user') text = textOf(event.data.content)
  if (event.type === 'assistant/message') text = textOf(record(event.data.message).content)
  if (tools && event.type === 'tool/result') text = textOf(record(event.data.message).content)
  if (tools && event.type === 'tool/call') text = JSON.stringify(event.data.call ?? event.data)
  if (!text.trim()) return
  return { seq: event.seq, type: event.type, time: event.time, revision: revisionOf(text), text: text.slice(0, maxChars), truncated: text.length > maxChars }
}
export function cacheEvidence(events: HostEvent[], tools: boolean) {
  const all = events.map(event => evidenceEvent(event, tools)).filter((event): event is EvidenceEvent => Boolean(event))
  const evidence: EvidenceEvent[] = []
  let remaining = 256_000
  for (const event of all.slice(-120).reverse()) {
    if (event.text.length > remaining) break
    evidence.unshift(event); remaining -= event.text.length
  }
  return { evidence, evidenceTruncated: evidence.length < all.length || evidence.some(event => event.truncated) }
}
