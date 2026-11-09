/**
 * Integration-level tests for lib/serve.js and lib/pairing.js.
 *
 * Each harness starts a real node:http listener on 127.0.0.1:0 with a temporary
 * store under os.tmpdir(), a stub owner-credentials object and a stub GUI proxy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import { defaultScope } from '../src/lib/scope.ts'
import { openStore } from '../src/lib/store.ts'
import {
  createPairing,
  createDeviceToken,
  hashToken,
  verifyToken,
} from '../src/lib/pairing.ts'
import { createDeviceLinkServer } from '../src/lib/serve.ts'

const silentLog = { info() {}, warn() {}, error() {} }

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function makeHarness(overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-device-link-serve-'))
  const store = await openStore({ home, log: silentLog })
  const pairing = createPairing({
    open: false,
    ttlMs: overrides.pairingTtlMs ?? 60_000,
  })

  const recorded = { handles: [], upgrades: [] }
  const credentials = { getCookie: async () => 'sid=stub' }
  const proxy = {
    async handle(req, res) {
      recorded.handles.push({
        url: req.url,
        cookie: req.headers.cookie ?? null,
        authorization: req.headers.authorization ?? null,
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('proxied')
    },
    handleUpgrade(req, socket, head) {
      recorded.upgrades.push({
        url: req.url,
        cookie: req.headers.cookie ?? null,
        headLength: head?.length ?? 0,
      })
      socket.write('upgraded')
      socket.end()
    },
  }

  const warnings = []
  const log = {
    info() {},
    warn: (...args) => warnings.push(args.join(' ')),
    error(...args) {
      warnings.push(args.join(' '))
    },
  }

  const server = createDeviceLinkServer({
    config: {
      port: overrides.port ?? 0,
      bindAddress: overrides.bindAddress ?? '127.0.0.1',
      deviceName: 'serve-test-host',
      allowIncoming: overrides.allowIncoming ?? true,
      accessTtlMs: overrides.accessTtlMs ?? 60_000,
      maxPairFailures: overrides.maxPairFailures ?? 8,
      failureWindowMs: overrides.failureWindowMs ?? 10 * 60_000,
      guiOrigin: 'http://127.0.0.1:1',
    },
    store,
    pairing,
    credentials,
    proxy,
    log,
  })

  let listen = null
  if (overrides.start !== false) listen = await server.start()
  const baseUrl = listen ? `http://${listen.host}:${listen.port}` : null

  return {
    home,
    store,
    pairing,
    server,
    proxy,
    recorded,
    warnings,
    listen,
    baseUrl,
    async cleanup() {
      await server.stop()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

async function request(url, options = {}) {
  const { method = 'GET', body, token, cookie, redirect = 'follow', headers = {} } = options
  const finalHeaders = { ...headers }
  if (body !== undefined) finalHeaders['content-type'] ??= 'application/json'
  if (token) finalHeaders.authorization = `Bearer ${token}`
  if (cookie) finalHeaders.cookie = cookie

  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect,
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { response, status: response.status, text, json, headers: response.headers }
}

async function pairDevice(harness, { deviceId = 'peer-device', name = 'Peer Device' } = {}) {
  const opened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
  const claim = await request(`${harness.baseUrl}/dl/pair/claim`, {
    method: 'POST',
    body: { code: opened.code, deviceId, name },
  })
  assert.equal(claim.status, 200, `claim failed: ${claim.text}`)
  assert.equal(claim.json?.ok, true)
  return { opened, claim, token: claim.json.token }
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

function rawUpgrade(port, pathname, extraHeaders = {}) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let data = ''
    let settled = false
    const timer = setTimeout(() => finish(true), 2000)
    function finish(timedOut) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ data, timedOut })
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
      ]
      for (const [key, value] of Object.entries(extraHeaders)) lines.push(`${key}: ${value}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.on('data', chunk => {
      data += chunk
    })
    socket.on('close', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

// --------------------------------------------------------------------- pairing

test('device tokens are random, hashed, and verified in constant time', () => {
  const first = createDeviceToken()
  const second = createDeviceToken()

  assert.equal(typeof first.token, 'string')
  assert.ok(first.token.length >= 43, `token too short: ${first.token}`)
  assert.match(first.token, /^[A-Za-z0-9_-]+$/)
  assert.match(first.tokenHash, /^[0-9a-f]{64}$/)
  assert.notEqual(first.token, second.token)

  assert.equal(first.hash, hashToken)
  assert.equal(first.tokenHash, hashToken(first.token))
  assert.equal(verifyToken(first.token, first.tokenHash), true)
  assert.equal(verifyToken(second.token, first.tokenHash), false)
  assert.equal(verifyToken(`${first.token}x`, first.tokenHash), false)
  // Stored hashes are lower-case hex; verification accepts upper case too.
  assert.equal(verifyToken(first.token, first.tokenHash.toUpperCase()), true)
  assert.equal(verifyToken('', first.tokenHash), false)
  assert.equal(verifyToken(first.token, ''), false)
  assert.equal(verifyToken(first.token, null), false)
  assert.equal(hashToken(''), '')
})

test('pairing codes are 8 digits, single use, TTL-bound, and burn after too many failures', async () => {
  const oneShot = createPairing({ ttlMs: 60_000 })
  const opened = oneShot.openPairing()
  assert.match(opened.code, /^\d{8}$/)
  assert.ok(!Number.isNaN(Date.parse(opened.expiresAt)))
  assert.equal(oneShot.isOpen(), true)
  assert.deepEqual(oneShot.consume(opened.code, 'ip-a'), { ok: true })
  assert.equal(oneShot.isOpen(), false)
  assert.deepEqual(oneShot.consume(opened.code, 'ip-a'), { ok: false, reason: 'mismatch' })

  const expiring = createPairing({ ttlMs: 10 })
  const shortLived = expiring.openPairing()
  await delay(40)
  assert.equal(expiring.isOpen(), false)
  assert.deepEqual(expiring.consume(shortLived.code, 'ip-a'), { ok: false, reason: 'expired' })

  const limited = createPairing({ ttlMs: 60_000, maxAttempts: 2 })
  limited.openPairing()
  assert.deepEqual(limited.consume('00000000', 'ip-a'), { ok: false, reason: 'mismatch' })
  assert.deepEqual(limited.consume('00000000', 'ip-a'), { ok: false, reason: 'attempts' })
  assert.equal(limited.isOpen(), false)

  const reset = createPairing({ ttlMs: 60_000 })
  const first = reset.openPairing()
  reset.consume('99999999', 'ip-a')
  const second = reset.openPairing()
  assert.notEqual(first.code, second.code)
  reset.closePairing()
  assert.equal(reset.isOpen(), false)
})

// --------------------------------------------------------------------- serve

test('GET /dl/info answers without auth and reports identity', async () => {
  const harness = await makeHarness()
  try {
    const info = await request(`${harness.baseUrl}/dl/info`)
    assert.equal(info.status, 200)
    assert.match(info.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/)
    assert.equal(info.json.ok, true)
    assert.equal(info.json.api, 'v2')
    assert.equal(info.json.app, 'dsh-device-link')
    assert.equal(info.json.version, '0.2.0')
    assert.equal(info.json.deviceId, harness.store.state().identity.deviceId)
    assert.equal(info.json.name, harness.store.state().identity.name)
    assert.equal(info.json.pairingOpen, false)
    assert.equal(info.json.trustedCount, 0)

    assert.deepEqual(harness.server.info().listen, {
      host: harness.listen.host,
      port: harness.listen.port,
    })
    assert.deepEqual(harness.server.addresses(), harness.server.addresses()) // stable array
    assert.ok(Array.isArray(harness.server.addresses()))
  } finally {
    await harness.cleanup()
  }
})

test('open pairing → claim → access → enter grants a session cookie', async () => {
  const harness = await makeHarness()
  try {
    const opened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
    assert.match(opened.code, /^\d{8}$/)
    assert.ok(!Number.isNaN(Date.parse(opened.expiresAt)))
    assert.equal(opened.port, harness.listen.port)
    assert.ok(Array.isArray(opened.addresses))
    for (const entry of opened.addresses) assert.equal(typeof entry.address, 'string')
    assert.equal(harness.pairing.isOpen(), true)
    assert.equal(harness.server.info().pairingOpen, true)

    const claim = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, deviceId: 'device-alpha', name: 'Alpha Laptop' },
    })
    assert.equal(claim.status, 200, claim.text)
    assert.equal(claim.json.ok, true)
    assert.equal(typeof claim.json.token, 'string')
    assert.equal(claim.json.deviceId, harness.store.state().identity.deviceId)
    assert.equal(claim.json.name, harness.store.state().identity.name)
    assert.equal(claim.json.api, 'v2')

    // Pairing is one-time; the code cannot be claimed twice.
    assert.equal(harness.pairing.isOpen(), false)
    const replay = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, deviceId: 'device-beta', name: 'Beta' },
    })
    assert.equal(replay.status, 403)
    assert.equal(replay.json.reason, 'mismatch')

    const stored = harness.store.state().trusted['device-alpha']
    assert.equal(stored.deviceId, 'device-alpha')
    assert.equal(stored.name, 'Alpha Laptop')
    assert.equal(stored.tokenHash, hashToken(claim.json.token))
    assert.equal(stored.active, true)
    assert.equal(typeof stored.createdAt, 'string')
    assert.equal(typeof stored.lastSeenAt, 'string')

    const info = await request(`${harness.baseUrl}/dl/info`)
    assert.equal(info.json.trustedCount, 1)
    assert.equal(info.json.pairingOpen, false)
    assert.deepEqual(harness.server.trusted(), [
      { deviceId: 'device-alpha', name: 'Alpha Laptop', lastSeenAt: stored.lastSeenAt, createdAt: stored.createdAt, active: true, relationship: 'same-account', scope: defaultScope('same-account') },
    ])

    const access = await request(`${harness.baseUrl}/dl/access`, {
      method: 'POST',
      token: claim.json.token,
    })
    assert.equal(access.status, 200, access.text)
    assert.equal(access.json.ok, true)
    assert.ok(access.json.url.startsWith(`${harness.baseUrl}/dl/enter?ac=`), access.json.url)
    assert.ok(Date.parse(access.json.expiresAt) > Date.now())

    const enter = await request(access.json.url, { redirect: 'manual' })
    assert.equal(enter.status, 302)
    assert.equal(enter.headers.get('location'), '/')
    const cookies = setCookies(enter.response)
    const session = cookies.find(value => value.startsWith('dl_session='))
    assert.ok(session, `missing dl_session cookie, got ${JSON.stringify(cookies)}`)
    assert.match(session, /HttpOnly/)
    assert.match(session, /SameSite=Strict/)
    assert.match(session, /Path=\//)
    assert.equal(session.split(';')[0], `dl_session=${claim.json.token}`)

    // The cookie from /dl/enter authenticates proxied requests.
    const cookie = session.split(';')[0]
    const proxied = await request(`${harness.baseUrl}/`, { cookie })
    assert.equal(proxied.status, 200)
    assert.equal(proxied.text, 'proxied')
  } finally {
    await harness.cleanup()
  }
})

test('cookie and Bearer tokens authenticate proxied requests; missing auth is 401', async () => {
  const harness = await makeHarness()
  try {
    const { token } = await pairDevice(harness, { deviceId: 'device-cookie', name: 'Cookie Device' })

    const withCookie = await request(`${harness.baseUrl}/index.html?tab=1`, {
      cookie: `dl_session=${token}`,
    })
    assert.equal(withCookie.status, 200)
    assert.equal(withCookie.text, 'proxied')
    assert.equal(harness.recorded.handles.length, 1)
    assert.equal(harness.recorded.handles[0].url, '/index.html?tab=1')
    assert.match(harness.recorded.handles[0].cookie ?? '', /dl_session=/)

    const withBearer = await request(`${harness.baseUrl}/api/whatever`, { token })
    assert.equal(withBearer.status, 200)
    assert.equal(harness.recorded.handles.length, 2)
    assert.equal(harness.recorded.handles[1].url, '/api/whatever')
    assert.equal(harness.recorded.handles[1].authorization, `Bearer ${token}`)

    const anonymous = await request(`${harness.baseUrl}/`)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.ok, false)
    assert.equal(harness.recorded.handles.length, 2)

    const badToken = await request(`${harness.baseUrl}/`, { token: 'not-a-real-token' })
    assert.equal(badToken.status, 401)
    assert.equal(harness.recorded.handles.length, 2)
  } finally {
    await harness.cleanup()
  }
})

test('upgrade requests are authenticated before reaching the proxy', async () => {
  const harness = await makeHarness()
  try {
    const { token } = await pairDevice(harness, { deviceId: 'device-ws', name: 'WS Device' })

    const authenticated = await rawUpgrade(harness.listen.port, '/ws', {
      Cookie: `dl_session=${token}`,
    })
    assert.equal(authenticated.timedOut, false)
    assert.ok(authenticated.data.startsWith('upgraded'), authenticated.data)
    assert.equal(harness.recorded.upgrades.length, 1)
    assert.match(harness.recorded.upgrades[0].cookie ?? '', /dl_session=/)

    const anonymous = await rawUpgrade(harness.listen.port, '/ws')
    assert.equal(anonymous.data, '')
    assert.equal(harness.recorded.upgrades.length, 1)
  } finally {
    await harness.cleanup()
  }
})

test('revoking a device drops its token and rejects later requests', async () => {
  const harness = await makeHarness()
  try {
    const alpha = await pairDevice(harness, { deviceId: 'device-alpha', name: 'Alpha' })
    const beta = await pairDevice(harness, { deviceId: 'device-beta', name: 'Beta' })
    assert.equal(harness.server.trusted().length, 2)

    // A device can only revoke itself.
    const forbidden = await request(`${harness.baseUrl}/dl/pair/revoke`, {
      method: 'POST',
      token: alpha.token,
      body: { deviceId: 'device-beta' },
    })
    assert.equal(forbidden.status, 403)
    assert.equal(harness.server.trusted().length, 2)

    const revoked = await request(`${harness.baseUrl}/dl/pair/revoke`, {
      method: 'POST',
      token: alpha.token,
      body: { deviceId: 'device-alpha' },
    })
    assert.equal(revoked.status, 200, revoked.text)
    assert.equal(revoked.json.ok, true)
    assert.deepEqual(
      harness.server.trusted().map(entry => entry.deviceId),
      ['device-beta'],
    )

    const after = await request(`${harness.baseUrl}/`, { cookie: `dl_session=${alpha.token}` })
    assert.equal(after.status, 401)
    const betaStillWorks = await request(`${harness.baseUrl}/`, { token: beta.token })
    assert.equal(betaStillWorks.status, 200)

    // server.revoke() is idempotent: true once, false afterwards.
    assert.equal(await harness.server.revoke('device-beta'), true)
    assert.equal(await harness.server.revoke('device-beta'), false)
    assert.equal(harness.server.trusted().length, 0)
    assert.equal(harness.server.info().trustedCount, 0)
  } finally {
    await harness.cleanup()
  }
})

test('wrong pairing codes report mismatch, then attempts, then rate limiting', async () => {
  const harness = await makeHarness({ maxPairFailures: 8 })
  try {
    const opened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
    const wrong = opened.code === '00000000' ? '00000001' : '00000000'

    const first = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: wrong, deviceId: 'device-x', name: 'X' },
    })
    assert.equal(first.status, 403)
    assert.equal(first.json.reason, 'mismatch')

    let last = null
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      last = await request(`${harness.baseUrl}/dl/pair/claim`, {
        method: 'POST',
        body: { code: wrong, deviceId: 'device-x', name: 'X' },
      })
    }
    assert.equal(last.status, 429)
    assert.equal(last.json.reason, 'attempts')
    assert.equal(harness.pairing.isOpen(), false)

    // The IP is now rate limited, even for the right code.
    const limited = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, deviceId: 'device-x', name: 'X' },
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.json.reason, 'rate_limited')

    // Re-opening pairing (an owner action) resets the failure counter.
    const reopened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
    const success = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: reopened.code, deviceId: 'device-x', name: 'X' },
    })
    assert.equal(success.status, 200, success.text)
    assert.equal(success.json.ok, true)
  } finally {
    await harness.cleanup()
  }
})

test('expired pairing codes answer 410 expired', async () => {
  const harness = await makeHarness({ pairingTtlMs: 15 })
  try {
    const opened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
    await delay(60)
    const claim = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, deviceId: 'device-late', name: 'Late' },
    })
    assert.equal(claim.status, 410)
    assert.equal(claim.json.reason, 'expired')
    assert.equal(harness.store.state().trusted['device-late'], undefined)
  } finally {
    await harness.cleanup()
  }
})

test('access codes are single use, TTL-bound, and tamper-proof', async () => {
  const harness = await makeHarness({ accessTtlMs: 5000 })
  try {
    const { token } = await pairDevice(harness, { deviceId: 'device-ac', name: 'AC Device' })
    const access = await request(`${harness.baseUrl}/dl/access`, { method: 'POST', token })
    assert.equal(access.status, 200)

    const firstEnter = await request(access.json.url, { redirect: 'manual' })
    assert.equal(firstEnter.status, 302)

    const replay = await request(access.json.url, { redirect: 'manual' })
    assert.equal(replay.status, 401)
    assert.equal(replay.json.ok, false)

    const tampered = await request(`${harness.baseUrl}/dl/enter?ac=not-a-real-code`, {
      redirect: 'manual',
    })
    assert.equal(tampered.status, 401)

    const missing = await request(`${harness.baseUrl}/dl/enter`, { redirect: 'manual' })
    assert.equal(missing.status, 401)

    // An access code without a token does not work either.
    const anonymousAccess = await request(`${harness.baseUrl}/dl/access`, { method: 'POST' })
    assert.equal(anonymousAccess.status, 401)
  } finally {
    await harness.cleanup()
  }
})

test('access codes expire after accessTtlMs', async () => {
  const harness = await makeHarness({ accessTtlMs: 15 })
  try {
    const { token } = await pairDevice(harness, { deviceId: 'device-ac2', name: 'AC Device 2' })
    const access = await request(`${harness.baseUrl}/dl/access`, { method: 'POST', token })
    assert.equal(access.status, 200)
    await delay(60)
    const enter = await request(access.json.url, { redirect: 'manual' })
    assert.equal(enter.status, 401)
  } finally {
    await harness.cleanup()
  }
})

test('pairing claims refuse malformed, oversized, and non-string bodies', async () => {
  const harness = await makeHarness()
  try {
    const opened = harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })

    const numeric = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: Number(opened.code), deviceId: 'device-n', name: 'N' },
    })
    assert.equal(numeric.status, 400)
    assert.equal(numeric.json.reason, 'invalid_request')

    const missingId = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, name: 'N' },
    })
    assert.equal(missingId.status, 400)

    // Prototype-polluting device ids are rejected, not used as store keys.
    const prototypeKey = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: opened.code, deviceId: '__proto__', name: 'N' },
    })
    assert.equal(prototypeKey.status, 400)
    assert.equal(Object.getPrototypeOf(harness.store.state().trusted), Object.prototype)

    const invalidJson = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: '{not json',
    })
    assert.equal(invalidJson.status, 400)
    assert.equal(invalidJson.json.reason, 'invalid_request')

    const oversized = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: JSON.stringify({ code: 'x'.repeat(70000), deviceId: 'device-o', name: 'O' }),
    })
    assert.equal(oversized.status, 413)
    assert.equal(oversized.json.reason, 'invalid_request')

    // None of the rejected requests paired anything.
    assert.equal(harness.server.trusted().length, 0)
  } finally {
    await harness.cleanup()
  }
})

test('allowIncoming=false refuses pairing and claims', async () => {
  const harness = await makeHarness({ allowIncoming: false })
  try {
    assert.throws(() => harness.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') }), /allowIncoming|disabled/i)

    const claim = await request(`${harness.baseUrl}/dl/pair/claim`, {
      method: 'POST',
      body: { code: '12345678', deviceId: 'device-nope', name: 'Nope' },
    })
    assert.equal(claim.status, 403)
    assert.equal(claim.json.ok, false)

    // /dl/info stays reachable so the peer can probe.
    const info = await request(`${harness.baseUrl}/dl/info`)
    assert.equal(info.status, 200)
    assert.equal(info.json.ok, true)
    assert.equal(info.json.trustedCount, 0)
  } finally {
    await harness.cleanup()
  }
})

test('start refuses wildcard and non-IPv4 bind addresses', async () => {
  const wildcard = await makeHarness({ start: false, bindAddress: '0.0.0.0' })
  try {
    await assert.rejects(() => wildcard.server.start(), /0\.0\.0\.0|wildcard|concrete/i)
  } finally {
    await wildcard.cleanup()
  }

  const invalid = await makeHarness({ start: false, bindAddress: 'auto' })
  try {
    await assert.rejects(() => invalid.server.start(), /IPv4|concrete/i)
  } finally {
    await invalid.cleanup()
  }
})

test('start falls back to an OS-assigned port when the configured port is busy', async () => {
  const first = await makeHarness()
  let second = null
  try {
    second = await makeHarness({ port: first.listen.port })
    assert.notEqual(second.listen.port, first.listen.port)
    assert.ok(second.listen.port > 0)
    assert.equal(second.listen.host, '127.0.0.1')
    assert.ok(
      second.warnings.some(text => /already in use|falling back/i.test(text)),
      `expected an EADDRINUSE warning, got ${JSON.stringify(second.warnings)}`,
    )
  } finally {
    if (second) await second.cleanup()
    await first.cleanup()
  }
})

test('stop() closes the listener and destroys client sockets', async () => {
  const harness = await makeHarness()
  const { token } = await pairDevice(harness, { deviceId: 'device-stop', name: 'Stop Device' })
  await request(`${harness.baseUrl}/health`, { token })

  const baseUrl = harness.baseUrl
  await harness.server.stop()
  assert.equal(harness.server.info().listen, null)
  await assert.rejects(() => fetch(`${baseUrl}/dl/info`))
  // stop() is idempotent.
  await harness.server.stop()
  await fs.rm(harness.home, { recursive: true, force: true })
})
