import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { createOwnerCredentials } from '../src/lib/credentials.ts'
import { createGuiProxy } from '../src/lib/proxy.ts'

const HOST = '127.0.0.1'
const verbose = Boolean(process.env.DL_TEST_VERBOSE)
const log = {
  info: (...args: unknown[]) => verbose && console.log(...args),
  warn: (...args: unknown[]) => verbose && console.warn(...args),
  error: (...args: unknown[]) => verbose && console.error(...args),
}

function listen(server: http.Server) {
  return new Promise<net.AddressInfo>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, HOST, () => {
      server.off('error', onError)
      resolve(server.address() as net.AddressInfo)
    })
  })
}

function waitForClose(socket: net.Socket, timeoutMs = 3_000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function closeServer(server: http.Server) {
  server.closeAllConnections()
  return new Promise<void>(resolve => server.close(() => resolve()))
}

function httpRequest({ port, path, method = 'GET', headers = {}, body }: { port: number; path: string; method?: string; headers?: http.OutgoingHttpHeaders; body?: string }) {
  return new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({ host: HOST, port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

async function freePort() {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, HOST, resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** Reads socket bytes while multiple sequential predicates wait for their marker. */
function createByteReader(socket: net.Socket) {
  const chunks: Buffer[] = []
  const waiters = new Set<{ check(): void }>()
  socket.on('data', chunk => {
    chunks.push(chunk)
    for (const waiter of [...waiters]) waiter.check()
  })
  socket.on('end', () => {
    for (const waiter of [...waiters]) waiter.check()
  })

  function waitFor<T>(predicate: (buffer: Buffer) => T | null | false, timeoutMs = 3_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: undefined as NodeJS.Timeout | undefined,
        check() {
          let result
          try {
            result = predicate(Buffer.concat(chunks))
          } catch (error) {
            finish()
            reject(error)
            return
          }
          if (result) {
            finish()
            resolve(result)
          }
        },
      }
      function finish() {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
      }
      waiter.timer = setTimeout(() => {
        finish()
        reject(new Error('timed out waiting for socket bytes'))
      }, timeoutMs)
      waiters.add(waiter)
      waiter.check()
    })
  }

  return { buffer: () => Buffer.concat(chunks), waitFor }
}

function createFakeGui() {
  const state: {
    token: string; issueSid: string; acceptedSid: string; exchanges: number;
    hits: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders }[];
    upgrades: { url: string | undefined; headers: http.IncomingHttpHeaders }[];
  } = {
    token: 'test-token-1',
    issueSid: 'abc',
    acceptedSid: 'abc',
    exchanges: 0,
    hits: [],
    upgrades: [],
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://gui.invalid')
    state.hits.push({ method: req.method, url: req.url, headers: req.headers })

    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== state.token) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad token')
        return
      }
      state.exchanges += 1
      state.acceptedSid = state.issueSid
      res.writeHead(302, {
        location: '/',
        'set-cookie': `sid=${state.issueSid}; Path=/; HttpOnly`,
      })
      res.end()
      return
    }

    const cookie = req.headers.cookie ?? ''
    const authorized = cookie.split(/;\s*/).includes(`sid=${state.acceptedSid}`)
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized', cookie }))
      return
    }

    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, path: url.pathname, method: req.method, sid: state.acceptedSid }))
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'gui_page=1; Path=/',
        connection: 'close, x-local-only',
        'x-local-only': 'private hop value',
      })
      res.end('<!doctype html><title>fake GUI</title><h1>fake GUI</h1>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    state.upgrades.push({ url: req.url, headers: req.headers })
    const cookie = req.headers.cookie ?? ''
    const authorized = cookie.split(/;\s*/).includes(`sid=${state.acceptedSid}`)
    if (!authorized) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nSet-Cookie: sid=secret; Path=/\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade, x-local-only\r\nSet-Cookie: sid=secret; Path=/\r\nx-local-only: private hop value\r\n\r\nserver-head-bytes')
    if (head?.length) socket.write(head)
    socket.on('data', chunk => socket.write(chunk))
    // A real WebSocket peer answers the client's FIN; the tunnel is a dumb pipe, so close here.
    socket.on('end', () => socket.end())
  })

  return { state, server }
}

test('owner credentials + GUI proxy', async t => {
  const gui = createFakeGui()
  const guiAddress = await listen(gui.server)
  const guiPort = guiAddress.port
  const guiOrigin = `http://${HOST}:${guiPort}`
  const authenticatedUrl = `${guiOrigin}/?token=${gui.state.token}`

  const credentials = createOwnerCredentials({
    origin: guiOrigin,
    getAuthenticatedUrl: () => authenticatedUrl,
    log,
  })
  const proxy = createGuiProxy({
    origin: guiOrigin,
    getCookie: () => credentials.getCookie(),
    onAuthFailure: () => credentials.invalidate(),
    log,
  })
  const proxyServer = http.createServer((req, res) => {
    void proxy.handle(req, res)
  })
  proxyServer.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head))
  const proxyAddress = await listen(proxyServer)
  const proxyPort = proxyAddress.port

  t.after(async () => {
    await closeServer(proxyServer)
    await closeServer(gui.server)
  })

  await t.test('exchanges the authenticated URL for the owner cookie and caches it', async () => {
    assert.equal(await credentials.getCookie(), 'sid=abc')
    assert.equal(gui.state.exchanges, 1)
    assert.equal(gui.state.hits[0].headers.cookie, undefined, 'the exchange request carries no cookie')

    assert.equal(await credentials.getCookie(), 'sid=abc')
    assert.equal(gui.state.exchanges, 1, 'a cached read must not re-exchange')

    credentials.invalidate()
    assert.equal(await credentials.getCookie(), 'sid=abc')
    assert.equal(gui.state.exchanges, 2, 'invalidate() forces a fresh exchange')
  })

  await t.test('proxies HTML with rewritten host/origin/referer and strips set-cookie', async () => {
    const response = await httpRequest({
      port: proxyPort,
      path: '/',
      headers: { referer: `http://${HOST}:${proxyPort}/index.html`, connection: 'close, x-client-only', 'x-client-only': 'private client value' },
    })
    assert.equal(response.status, 200)
    assert.match(String(response.headers['content-type']), /text\/html/)
    assert.match(response.body, /fake GUI/)
    assert.equal(response.headers['set-cookie'], undefined, 'GUI Set-Cookie must stay host-side')
    assert.equal(response.headers['x-local-only'], undefined)

    const hit = gui.state.hits.find(entry => entry.url === '/')
    assert.ok(hit, 'the GUI must have seen GET /')
    assert.equal(hit.headers.host, `${HOST}:${guiPort}`)
    assert.equal(hit.headers.origin, guiOrigin)
    assert.equal(hit.headers.referer, `${guiOrigin}/index.html`)
    assert.equal(hit.headers.cookie, 'sid=abc')
    assert.equal(hit.headers['x-client-only'], undefined)
  })

  await t.test('proxies JSON from /api/data', async () => {
    const response = await httpRequest({ port: proxyPort, path: '/api/data' })
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.method, 'GET')
    assert.equal(payload.sid, 'abc')
  })

  await t.test('401 -> invalidate -> retries once with a fresh owner cookie', async () => {
    gui.state.issueSid = 'def'
    gui.state.acceptedSid = 'def'
    const exchangesBefore = gui.state.exchanges
    const hitsBefore = gui.state.hits.filter(entry => entry.url === '/api/data').length

    const response = await httpRequest({ port: proxyPort, path: '/api/data' })
    assert.equal(response.status, 200, 'the retried request must succeed and hide the 401')
    assert.equal(JSON.parse(response.body).sid, 'def')
    assert.equal(gui.state.exchanges, exchangesBefore + 1, 'exactly one credential refresh')
    assert.equal(
      gui.state.hits.filter(entry => entry.url === '/api/data').length,
      hitsBefore + 2,
      'one rejected attempt plus one retry',
    )
  })

  await t.test('upgrades tunnel bytes both ways and forward the handshake head', async () => {
    const socket = net.connect(proxyPort, HOST)
    socket.on('error', () => {})
    const reader = createByteReader(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const head = Buffer.from('first-head-bytes')
    const handshake = [
      'GET /api/mux HTTP/1.1',
      `Host: ${HOST}:${proxyPort}`,
      'Connection: Upgrade, x-client-only',
      'x-client-only: private client value',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: http://${HOST}:${proxyPort}`,
      `Referer: http://${HOST}:${proxyPort}/`,
      '',
      '',
    ].join('\r\n')
    socket.write(Buffer.concat([Buffer.from(handshake), head]))

    // Client bytes written after the handshake headers are delivered as `head` to handleUpgrade;
    // the GUI must receive them after its 101 and echo them back.
    const first = await reader.waitFor(buffer => {
      const text = buffer.toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end === -1) return null
      const headerEnd = end + 4
      if (buffer.length < headerEnd + 'server-head-bytes'.length + head.length) return null
      return { header: text.slice(0, headerEnd), body: text.slice(headerEnd) }
    })
    assert.match(first.header, /^HTTP\/1\.1 101/)
    assert.doesNotMatch(first.header, /set-cookie|sid=secret|x-local-only/i)
    assert.equal(first.body, 'server-head-bytesfirst-head-bytes')

    socket.write('second-round')
    await reader.waitFor(buffer => buffer.toString('latin1').includes('second-round'))

    const upgrade = gui.state.upgrades.at(-1)
    assert.ok(upgrade, 'the GUI must have seen an upgrade')
    assert.equal(upgrade.url, '/api/mux')
    assert.equal(upgrade.headers.host, `${HOST}:${guiPort}`)
    assert.equal(upgrade.headers.origin, guiOrigin)
    assert.equal(upgrade.headers.referer, `${guiOrigin}/`)
    assert.equal(upgrade.headers.cookie, 'sid=def')
    assert.equal(upgrade.headers.connection, 'Upgrade')
    assert.equal(upgrade.headers.upgrade, 'websocket')
    assert.equal(upgrade.headers['x-client-only'], undefined)

    const closed = waitForClose(socket)
    socket.end()
    await closed
  })

  await t.test('does not retry non-idempotent requests on 401', async () => {
    gui.state.issueSid = 'zzz'
    gui.state.acceptedSid = 'zzz'
    const exchangesBefore = gui.state.exchanges
    const postsBefore = gui.state.hits.filter(entry => entry.method === 'POST').length

    const response = await httpRequest({
      port: proxyPort,
      path: '/api/data',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    })
    assert.equal(response.status, 401, 'POST 401 is passed through instead of replayed')
    assert.equal(gui.state.exchanges, exchangesBefore, 'no cookie refresh for non-idempotent methods')
    assert.equal(
      gui.state.hits.filter(entry => entry.method === 'POST').length,
      postsBefore + 1,
      'exactly one upstream attempt',
    )
  })

  await t.test('failed upgrades also strip owner cookies before closing the connection', async () => {
    const socket = net.connect(proxyPort, HOST)
    socket.on('error', () => {})
    const reader = createByteReader(socket)
    const closed = waitForClose(socket)
    socket.write(`GET /api/mux HTTP/1.1\r\nHost: ${HOST}:${proxyPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    const response = await reader.waitFor(buffer => buffer.toString().includes('\r\n\r\n') ? buffer.toString() : null)
    assert.match(response, /^HTTP\/1\.1 401/)
    assert.doesNotMatch(response, /set-cookie|sid=secret/i)
    await closed
  })

  await t.test('throws a clear error when the GUI origin is unavailable', async () => {
    const missing = createOwnerCredentials({ origin: '', getAuthenticatedUrl: () => 'unused', log })
    await assert.rejects(missing.getCookie(), /web GUI origin unavailable/)
    await assert.rejects(missing.refresh(), /web GUI origin unavailable/)
  })

  await t.test('reports upstream connection failures as 502 JSON', async () => {
    const deadPort = await freePort()
    const deadProxy = createGuiProxy({
      origin: `http://${HOST}:${deadPort}`,
      getCookie: async () => 'sid=abc',
      onAuthFailure: () => {},
      log,
    })
    const deadServer = http.createServer((req, res) => {
      void deadProxy.handle(req, res)
    })
    const deadAddress = await listen(deadServer)
    try {
      const response = await httpRequest({ port: deadAddress.port, path: '/' })
      assert.equal(response.status, 502)
      const payload = JSON.parse(response.body)
      assert.equal(payload.ok, false)
      assert.match(payload.error, /ECONNREFUSED|connect/i)
    } finally {
      await closeServer(deadServer)
    }
  })
})

test('owner credentials require the authenticated GUI URL', async t => {
  const gui = createFakeGui()
  const guiAddress = await listen(gui.server)
  const guiOrigin = `http://${HOST}:${guiAddress.port}`
  t.after(() => closeServer(gui.server))

  await t.test('dedupes concurrent refreshes into one exchange', async () => {
    const credentials = createOwnerCredentials({
      origin: guiOrigin,
      getAuthenticatedUrl: () => `${guiOrigin}/?token=${gui.state.token}`,
      log,
    })
    const [fromGet, fromRefresh, fromSecondGet] = await Promise.all([
      credentials.getCookie(),
      credentials.refresh(),
      credentials.getCookie(),
    ])
    assert.equal(fromGet, 'sid=abc')
    assert.equal(fromRefresh, 'sid=abc')
    assert.equal(fromSecondGet, 'sid=abc')
    assert.equal(gui.state.exchanges, 1, 'one in-flight exchange shared by all callers')
  })

  await t.test('rejects bare tokens, relative URLs, missing tokens and foreign origins before fetching', async () => {
    const before = gui.state.hits.length
    for (const url of [gui.state.token, '/?token=x', guiOrigin, 'http://192.168.1.2/?token=x']) {
      const credentials = createOwnerCredentials({ origin: guiOrigin, getAuthenticatedUrl: () => url,
        fetchImpl: async () => { assert.fail('invalid authentication URL must not be fetched') }, log })
      await assert.rejects(credentials.getCookie(), /URL|token/i)
    }
    assert.equal(gui.state.hits.length, before)
  })

  await t.test('bad token surfaces the HTTP status', async () => {
    const credentials = createOwnerCredentials({
      origin: guiOrigin,
      getAuthenticatedUrl: () => `${guiOrigin}/?token=wrong-token`,
      log,
    })
    await assert.rejects(credentials.getCookie(), /HTTP 401/)
  })
})

test('an invalidated in-flight cookie exchange cannot replace a newer cached cookie', async () => {
  let releaseFirst!: (response: Response) => void
  const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve })
  let firstStarted!: () => void
  const started = new Promise<void>(resolve => { firstStarted = resolve })
  let exchanges = 0
  const credentials = createOwnerCredentials({
    origin: 'http://127.0.0.1:47655', getAuthenticatedUrl: () => 'http://127.0.0.1:47655/?token=owner',
    fetchImpl: async () => {
      if (++exchanges === 1) { firstStarted(); return firstResponse }
      return new Response(null, { status: 302, headers: { 'set-cookie': 'sid=new; Path=/' } })
    },
  })
  const oldRead = credentials.getCookie()
  await started
  credentials.invalidate()
  assert.equal(await credentials.getCookie(), 'sid=new')
  releaseFirst(new Response(null, { status: 302, headers: { 'set-cookie': 'sid=old; Path=/' } }))
  assert.equal(await oldRead, 'sid=old')
  assert.equal(await credentials.getCookie(), 'sid=new')
  assert.equal(exchanges, 2)
})
