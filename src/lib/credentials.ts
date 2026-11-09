import type { Logger } from './types.js'
/**
 * Owner credentials: exchange the plugin's authenticated GUI URL for the owner browser cookie.
 *
 * The Harness web server answers `GET <origin>/?token=<process-token>` with `302` + `Set-Cookie`
 * (the owner session cookie, valid for weeks). We cache that cookie and hand it to the proxy,
 * which replays it on every forwarded request. `invalidate()` drops the cache after a 401/403 so
 * the next `getCookie()` performs a fresh exchange.
 */

const EXCHANGE_TIMEOUT_MS = 5_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307])

function getSetCookies(headers: Headers) {
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  // Fallback for fetch implementations without the split API: a combined header only yields the
  // first cookie reliably, which is exactly what we need.
  const combined = headers.get?.('set-cookie')
  return combined ? [combined] : []
}

/** `name=value` only: attributes (Path, HttpOnly, Expires, …) are not part of a Cookie header. */
function firstCookiePair(setCookies: string[]) {
  const raw = setCookies[0]
  if (!raw) return undefined
  const pair = raw.split(';', 1)[0].trim()
  return pair.includes('=') ? pair : undefined
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel?.()
  } catch {
    // A cancelled body is best effort; the connection is not replayed.
  }
}

export function createOwnerCredentials({
  origin,
  getAuthenticatedUrl,
  fetchImpl = globalThis.fetch,
  log,
}: { origin: string; getAuthenticatedUrl: () => string | Promise<string>; fetchImpl?: typeof fetch; log?: Logger }) {
  let cookie: string | undefined
  let inflight: Promise<string> | null = null

  /**
   * `getAuthenticatedUrl()` may return either the full authenticated URL (the real Harness
   * contract: `origin/?token=…`) or a bare token. Both are accepted.
   */
  async function resolveExchangeUrl() {
    const raw = await getAuthenticatedUrl()
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim()
    if (!value) throw new Error('web GUI authentication token unavailable')
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      // Absolute URL: use it verbatim. When it carries `?token=` it is already the exchange URL;
      // an absolute URL without a token is still the caller's best description of the endpoint.
      return new URL(value).toString()
    }
    const base = origin.replace(/\/+$/, '')
    if (value.startsWith('/')) {
      const relative = new URL(value, `${base}/`)
      if (relative.searchParams.has('token')) return relative.toString()
    }
    return `${base}/?token=${encodeURIComponent(value)}`
  }

  async function runRefresh() {
    if (!origin) throw new Error('web GUI origin unavailable')
    const exchangeUrl = await resolveExchangeUrl()
    const response = await fetchImpl(exchangeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
    const status = response.status

    if (status === 200 || REDIRECT_STATUSES.has(status)) {
      const pair = firstCookiePair(getSetCookies(response.headers))
      await discardBody(response)
      if (!pair) {
        throw new Error(
          `owner cookie exchange returned HTTP ${status} without a usable Set-Cookie header (origin ${origin})`,
        )
      }
      cookie = pair
      log?.info?.(`owner cookie acquired (HTTP ${status})`)
      return pair
    }

    await discardBody(response)
    throw new Error(`owner cookie exchange failed with HTTP ${status} (origin ${origin})`)
  }

  /** Force a new exchange. Concurrent callers share one in-flight request. */
  function refresh() {
    if (!origin) return Promise.reject(new Error('web GUI origin unavailable'))
    if (inflight) return inflight
    const pending = runRefresh()
    inflight = pending
    const clear = () => {
      if (inflight === pending) inflight = null
    }
    pending.then(clear, clear)
    return pending
  }

  /** Cached owner cookie; exchanges it once on first use or after `invalidate()`. */
  async function getCookie() {
    if (cookie) return cookie
    return refresh()
  }

  /** Drop the cached cookie (call on 401/403 from the GUI; the next read re-exchanges). */
  function invalidate() {
    cookie = undefined
    inflight = null
  }

  return { getCookie, invalidate, refresh }
}
