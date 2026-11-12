import type { IncomingMessage, ServerResponse, ClientRequest, IncomingHttpHeaders } from 'node:http'
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

// Connection can nominate additional hop-by-hop headers beyond this fixed list.
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

const RETRYABLE_STATUS = new Set([401, 403])
const RETRYABLE_METHODS = new Set(['GET', 'HEAD'])

function isLoopbackHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

function connectionHeaders(headers: IncomingHttpHeaders) {
  return new Set((headers.connection ?? '').split(',').map(name => name.trim().toLowerCase()))
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const nominated = connectionHeaders(headers)
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined
    && name !== 'set-cookie' && !HOP_BY_HOP.has(name) && !nominated.has(name)))
}

export function createGuiProxy({ origin, getCookie, onAuthFailure, log, timeoutMs = 30_000 }: { origin: string; getCookie: () => Promise<string>; onAuthFailure?: () => void; log?: Logger; timeoutMs?: number }) {
  const target = new URL(origin)
  if (!isLoopbackHostname(target.hostname)) throw new Error('GUI proxy target must be loopback')
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('GUI proxy target must use HTTP or HTTPS')
  const secure = target.protocol === 'https:'
  const transport = secure ? https : http
  const targetPort = Number(target.port || (secure ? 443 : 80))
  // URL keeps IPv6 literals bracketed; the HTTP client's host option needs the bare address.
  const targetHost = target.hostname.replace(/^\[(.*)\]$/, '$1')
  const targetOrigin = target.origin

  function incomingOrigin(req: IncomingMessage) {
    return req.headers.host ? `http://${req.headers.host}` : undefined
  }

  function rewriteReferer(referer: string | undefined, req: IncomingMessage) {
    if (!referer) return undefined
    try {
      const url = new URL(referer)
      if (url.origin === targetOrigin) return referer
      if (url.origin === incomingOrigin(req)) {
        return targetOrigin + url.pathname + url.search + url.hash
      }
      return referer
    } catch {
      return referer
    }
  }

  function requestHeaders(req: IncomingMessage, cookie: string) {
    const headers: Record<string, string> = {}
    const nominated = connectionHeaders(req.headers)
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || nominated.has(lower) || lower === 'authorization') continue
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
          // Only reads can be replayed after replacing an expired owner cookie.
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
          for (const [name, value] of Object.entries(responseHeaders(upstreamRes.headers))) {
            if (value === undefined) continue
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

  function writeUpgradeResponse(socket: Duplex, response: IncomingMessage, upgraded: boolean) {
    const headers = responseHeaders(response.headers)
    if (upgraded) {
      headers.connection = 'Upgrade'
      headers.upgrade = response.headers.upgrade
    } else headers.connection = 'close'
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ''}`]
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) lines.push(`${name}: ${item}`)
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
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
    // Buffer client bytes while credentials and the upstream handshake are pending.
    socket.pause()
    socket.on('error', () => {})
    void getCookie().then(cookie => {
      if (socket.destroyed) return
      const upstream = transport.request({
        host: targetHost, port: targetPort, method: req.method ?? 'GET', path: req.url ?? '/', agent: false,
        headers: { ...requestHeaders(req, cookie), connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' },
      })
      socket.once('close', () => upstream.destroy())
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('GUI upgrade timed out')))
      upstream.on('error', error => {
        log?.warn?.(`proxy: upgrade failed: ${errorMessage(error)}`)
        refuseUpgrade(socket, 'upgrade failed')
      })
      upstream.once('response', response => {
        if (socket.destroyed) { response.destroy(); return }
        writeUpgradeResponse(socket, response, false)
        response.on('error', () => socket.destroy())
        response.pipe(socket)
      })
      upstream.once('upgrade', (response, tunnel, upstreamHead) => {
        if (socket.destroyed) { tunnel.destroy(); return }
        // Parse the response before tunneling so owner cookies cannot cross the LAN boundary.
        writeUpgradeResponse(socket, response, true)
        const teardown = () => { socket.destroy(); tunnel.destroy() }
        socket.on('error', teardown)
        tunnel.on('error', teardown)
        socket.once('close', () => tunnel.destroy())
        tunnel.once('close', () => socket.destroy())
        tunnel.setTimeout(0)
        tunnel.setNoDelay(true)
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) tunnel.write(head)
        socket.pipe(tunnel)
        tunnel.pipe(socket)
        socket.resume()
      })
      upstream.end()
    }).catch(error => {
      log?.warn?.(`proxy: upgrade rejected: ${errorMessage(error)}`)
      refuseUpgrade(socket, 'owner credentials unavailable')
    })
  }

  return { handle, handleUpgrade }
}
