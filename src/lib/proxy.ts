import type { IncomingMessage, ServerResponse, ClientRequest } from 'node:http'
import type { Duplex } from 'node:stream'
import { errorMessage, type Logger } from './types.js'

interface ForwardResult { retry?: boolean; error?: unknown }
/**
 * Reverse proxy to the local Harness GUI. The device-link listener authenticates its own callers,
 * then forwards their HTTP requests and WebSocket upgrades to the GUI origin with the owner cookie
 * injected — so a paired device sees the executing host's full UI without ever holding owner creds.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** Hop-by-hop headers (RFC 7230 §6.1) never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Response headers the local client must not receive: the owner/refresh cookies stay host-side. */
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'transfer-encoding'])

const RETRYABLE_STATUS = new Set([401, 403])
const RETRYABLE_METHODS = new Set(['GET', 'HEAD'])

function isLoopbackHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function createGuiProxy({ origin, getCookie, onAuthFailure, log, timeoutMs = 30_000 }: { origin: string; getCookie: () => Promise<string>; onAuthFailure?: () => void; log?: Logger; timeoutMs?: number }) {
  const target = new URL(origin)
  if (!isLoopbackHostname(target.hostname)) throw new Error('GUI proxy target must be loopback')
  const secure = target.protocol === 'https:'
  const transport = secure ? https : http
  const connect = (options: net.TcpNetConnectOpts) => secure ? tls.connect(options) : net.connect(options)
  const targetPort = Number(target.port || (secure ? 443 : 80))
  // URL keeps IPv6 literals bracketed; net/tls connect wants the bare address.
  const targetHost = target.hostname.replace(/^\[(.*)\]$/, '$1')
  const targetOrigin = target.origin

  function incomingOrigin(req: IncomingMessage) {
    return req.headers.host ? `http://${req.headers.host}` : undefined
  }

  /** Only rewrite a Referer that pointed at this listener; leave foreign referers untouched. */
  function rewriteReferer(referer: string | undefined, req: IncomingMessage) {
    if (!referer) return undefined
    try {
      const url = new URL(referer)
      if (url.origin === targetOrigin) return referer
      if (url.origin === incomingOrigin(req) || isLoopbackHostname(url.hostname)) {
        return targetOrigin + url.pathname + url.search + url.hash
      }
      return referer
    } catch {
      return referer
    }
  }

  /** Copy + rewrite request headers for the GUI: owner cookie in, hop-by-hop headers out. */
  function requestHeaders(req: IncomingMessage, cookie: string) {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'authorization') continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    headers.host = target.host
    headers.origin = targetOrigin
    const referer = rewriteReferer(headers.referer, req)
    if (referer) headers.referer = referer
    else delete headers.referer
    headers.cookie = cookie
    return headers
  }

  function fail(res: ServerResponse, error: unknown, status = 502) {
    const message = errorMessage(error)
    log?.warn?.(`proxy: ${message}`)
    if (res.headersSent || res.destroyed || res.writableEnded) {
      if (!res.destroyed) res.destroy()
      return
    }
    const body = JSON.stringify({ ok: false, error: message })
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    })
    res.end(body)
  }

  /**
   * One forwarded attempt. Resolves with `{ retry: true }` when the GUI rejected the owner cookie
   * on an idempotent request and the caller should invalidate + retry once.
   */
  function forward(req: IncomingMessage, res: ServerResponse, cookie: string, { retried }: { retried: boolean }) {
    return new Promise<ForwardResult>(resolve => {
      const method = (req.method || 'GET').toUpperCase()
      let settled = false
      const settle = (value: ForwardResult) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      let upstream: ClientRequest
      try {
        upstream = transport.request({
          host: targetHost,
          port: targetPort,
          method,
          path: req.url || '/',
          headers: requestHeaders(req, cookie),
          agent: false,
        })
      } catch (error) {
        settle({ error })
        return
      }

      // Client hung up before/while the response completed: stop the upstream exchange.
      const onResClose = () => {
        if (!res.writableFinished && !upstream.destroyed) upstream.destroy()
      }
      res.on('close', onResClose)

      upstream.on('error', error => settle({ error }))
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('GUI proxy request timed out')))

      upstream.on('response', upstreamRes => {
        // Always keep an error listener on the response; a dropped connection mid-drain must not
        // surface as an unhandled 'error' event in the host process.
        upstreamRes.on('error', () => {})
        const status = upstreamRes.statusCode ?? 502

        if (!retried && RETRYABLE_METHODS.has(method) && RETRYABLE_STATUS.has(status)) {
          // Idempotent request rejected: do not leak the 401/403 to the client, retry with a fresh
          // owner cookie instead. Bodies are drained so the socket can be reused.
          upstreamRes.resume()
          settle({ retry: true })
          return
        }

        if (res.destroyed || res.headersSent) {
          upstreamRes.destroy()
          settle({})
          return
        }

        try {
          res.statusCode = status
          if (upstreamRes.statusMessage) res.statusMessage = upstreamRes.statusMessage
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue
            if (DROPPED_RESPONSE_HEADERS.has(name)) continue
            res.setHeader(name, value)
          }
        } catch (error) {
          upstreamRes.destroy()
          settle({ error })
          return
        }

        if (method === 'HEAD' || status === 204 || status === 304) {
          upstreamRes.resume()
          res.end()
          settle({})
          return
        }

        upstreamRes.on('error', error => {
          if (!res.destroyed) res.destroy(error)
          settle({})
        })
        upstreamRes.on('end', () => settle({}))
        upstreamRes.pipe(res)
      })

      if (retried) {
        // The client request stream was consumed by the first attempt; end the retry immediately.
        upstream.end()
      } else {
        req.on('error', error => {
          if (!upstream.destroyed) upstream.destroy(error)
        })
        req.pipe(upstream)
      }
    })
  }

  async function run(req: IncomingMessage, res: ServerResponse) {
    const method = (req.method || 'GET').toUpperCase()

    let cookie
    try {
      cookie = await getCookie()
    } catch (error) {
      fail(res, `owner credentials unavailable: ${errorMessage(error)}`)
      return
    }

    const first = await forward(req, res, cookie, { retried: false })
    if (first.error) {
      fail(res, first.error)
      return
    }
    if (!first.retry) return

    log?.info?.(`proxy: ${method} ${req.url} rejected the owner cookie; refreshing and retrying once`)
    try {
      onAuthFailure?.()
    } catch (error) {
      log?.warn?.(`proxy: onAuthFailure failed: ${errorMessage(error)}`)
    }
    try {
      cookie = await getCookie()
    } catch (error) {
      fail(res, `owner credentials unavailable: ${errorMessage(error)}`)
      return
    }

    const second = await forward(req, res, cookie, { retried: true })
    if (second.error) fail(res, second.error)
  }

  function handle(req: IncomingMessage, res: ServerResponse) {
    return new Promise<void>(resolve => {
      let done = false
      const settle = () => {
        if (done) return
        done = true
        resolve()
      }
      res.on('finish', settle)
      res.on('close', settle)
      res.on('error', () => {})
      run(req, res).catch(error => {
        fail(res, error)
        settle()
      })
    })
  }

  /** Hand-written upgrade request (request line + rewritten headers + owner cookie). */
  function upgradeRequest(req: IncomingMessage, cookie: string) {
    const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`]
    const raw = req.rawHeaders ?? []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i]
      const value = raw[i + 1]
      const lower = name.toLowerCase()
      // Re-created below; never forward the local listener's Host/Origin/Referer/cookie.
      if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'cookie') continue
      // WebSocket needs these two, rewritten to exactly one canonical pair.
      if (lower === 'connection' || lower === 'upgrade') continue
      if (HOP_BY_HOP.has(lower) || lower === 'authorization') continue
      lines.push(`${name}: ${value}`)
    }
    lines.push(`Host: ${target.host}`)
    lines.push('Connection: Upgrade')
    if (req.headers.upgrade) lines.push(`Upgrade: ${req.headers.upgrade}`)
    lines.push(`Origin: ${targetOrigin}`)
    const referer = rewriteReferer(req.headers.referer, req)
    if (referer) lines.push(`Referer: ${referer}`)
    lines.push(`Cookie: ${cookie}`)
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')
  }

  function refuseUpgrade(socket: Duplex, message: string) {
    if (socket.destroyed) return
    try {
      const body = Buffer.from(message, 'utf8')
      socket.end(
        'HTTP/1.1 502 Bad Gateway\r\n' +
          'Connection: close\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          `Content-Length: ${body.length}\r\n\r\n` +
          message,
      )
    } catch {
      socket.destroy()
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Buffer client bytes that arrive while we fetch the owner cookie; pipe() resumes the socket.
    socket.pause?.()
    socket.on('error', () => {})

    Promise.resolve()
      .then(() => getCookie())
      .then(cookie => {
        if (socket.destroyed) return
        let upstream
        try {
          upstream = connect({ host: targetHost, port: targetPort })
        } catch (error) {
          log?.warn?.(`proxy: upgrade connect failed: ${errorMessage(error)}`)
          refuseUpgrade(socket, 'upgrade failed')
          return
        }

        const teardown = () => {
          if (!socket.destroyed) socket.destroy()
          if (!upstream.destroyed) upstream.destroy()
        }
        upstream.on('error', error => {
          log?.warn?.(`proxy: upgrade upstream error: ${errorMessage(error)}`)
          teardown()
        })
        socket.on('error', teardown)
        upstream.on('close', () => {
          if (!socket.destroyed) socket.destroy()
        })
        socket.on('close', () => {
          if (!upstream.destroyed) upstream.destroy()
        })
        upstream.setNoDelay?.(true)

        upstream.write(upgradeRequest(req, cookie))
        if (head?.length) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
        socket.resume?.()
      })
      .catch(error => {
        log?.warn?.(`proxy: upgrade rejected: ${errorMessage(error)}`)
        refuseUpgrade(socket, 'owner credentials unavailable')
      })
  }

  return { handle, handleUpgrade }
}
