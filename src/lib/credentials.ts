import type { Logger } from './types.js'
// The owner cookie stays in this process; the LAN proxy supplies it to the local GUI.

const EXCHANGE_TIMEOUT_MS = 5_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307])

/** `name=value` only: attributes (Path, HttpOnly, Expires, …) are not part of a Cookie header. */
function firstCookiePair(setCookies: string[]) {
  const raw = setCookies[0]
  if (!raw) return undefined
  const pair = raw.split(';', 1)[0].trim()
  return pair.includes('=') ? pair : undefined
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // Body cleanup must not mask the exchange's HTTP status.
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

  async function resolveExchangeUrl() {
    const url = new URL(await getAuthenticatedUrl())
    if (url.origin !== new URL(origin).origin || url.username || url.password || !url.searchParams.get('token')) {
      throw new Error('web GUI authentication URL must contain a token for the GUI origin')
    }
    return url.toString()
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
      const pair = firstCookiePair(response.headers.getSetCookie())
      await discardBody(response)
      if (!pair) {
        throw new Error(
          `owner cookie exchange returned HTTP ${status} without a usable Set-Cookie header (origin ${origin})`,
        )
      }
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
    const pending = runRefresh().then(pair => {
      if (inflight === pending) cookie = pair
      return pair
    })
    inflight = pending
    const clear = () => {
      if (inflight === pending) inflight = null
    }
    pending.then(clear, clear)
    return pending
  }

  async function getCookie() {
    if (cookie) return cookie
    return refresh()
  }

  function invalidate() {
    cookie = undefined
    inflight = null
  }

  return { getCookie, invalidate, refresh }
}
