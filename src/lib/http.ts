import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, record } from './types.js'

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 64 * 1024) {
      req.resume()
      throw new HttpError(413, 'request body too large')
    }
    chunks.push(Buffer.from(chunk))
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return record(value)
  } catch { throw new HttpError(400, 'JSON object required') }
}
