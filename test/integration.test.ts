import { defaultScope } from '../src/lib/scope.ts'
import { collectHostFacts } from '../src/lib/host-facts.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { openStore } from '../src/lib/store.ts'
import { createPairing } from '../src/lib/pairing.ts'
import { createOwnerCredentials } from '../src/lib/credentials.ts'
import { createGuiProxy } from '../src/lib/proxy.ts'
import { createDeviceLinkServer } from '../src/lib/serve.ts'
import { createConnector } from '../src/lib/connect.ts'

const silentLog = { info() {}, warn() {}, error() {} }

/** Stand-in for the DSH web GUI: token exchange -> owner cookie -> page + JSON + websocket echo. */
async function startFakeGui() {
  /** `closeAllConnections()` does not cover upgraded sockets: the server detaches them. */
  const upgradeSockets = new Set<Duplex>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    const cookie = String(req.headers.cookie ?? '')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      res.writeHead(302, { location: '/', 'set-cookie': ['sid=owner-1; Path=/; HttpOnly; SameSite=Strict'] })
      res.end()
      return
    }
    if (!cookie.includes('sid=owner-1')) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>fake remote gui</body></html>')
      return
    }
    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, cookie }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.on('upgrade', (req, socket) => {
    upgradeSockets.add(socket)
    socket.on('close', () => upgradeSockets.delete(socket))
    socket.on('error', () => {})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write(`ECHO:cookie=${String(req.headers.cookie ?? '')}\r\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of upgradeSockets) socket.destroy()
      upgradeSockets.clear()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function startInstance({ home, name, guiOrigin }: { home: string; name: string; guiOrigin: string }) {
  const store = await openStore({ home, deviceName: name, log: silentLog })
  const pairing = createPairing({ ttlMs: 120_000 })
  const credentials = createOwnerCredentials({
    origin: guiOrigin,
    getAuthenticatedUrl: async () => `${guiOrigin}/?token=launch-token`,
    log: silentLog,
  })
  const proxy = createGuiProxy({
    origin: guiOrigin,
    getCookie: () => credentials.getCookie(),
    onAuthFailure: () => credentials.invalidate(),
    log: silentLog,
  })
  const server = createDeviceLinkServer({
    config: {
      port: 0,
      bindAddress: '127.0.0.1',
      allowIncoming: true,
      accessTtlMs: 60_000,
      maxPairFailures: 8,
      failureWindowMs: 600_000,
    },
    store,
    pairing,
    factsProvider: () => collectHostFacts({ get: () => undefined }),
    proxy,
    log: silentLog,
  })
  const listen = await server.start()
  return { store, server, listen, base: `http://127.0.0.1:${listen.port}` }
}

function upgradeEcho(host: string, port: number, cookie: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host, port })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('upgrade timed out'))
    }, 4_000)
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.includes('ECHO:')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(buffer)
      }
    })
    socket.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => {
      socket.write(
        [
          'GET /api/mux HTTP/1.1',
          `Host: ${host}:${port}`,
          `Origin: http://${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Cookie: ${cookie}`,
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

test('pair over the LAN listener, open the remote GUI, revoke', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-device-link-'))
  const gui = await startFakeGui()
  const instanceA = await startInstance({ home: path.join(root, 'a'), name: 'machine-a', guiOrigin: gui.origin })
  const instanceB = await startInstance({ home: path.join(root, 'b'), name: 'machine-b', guiOrigin: gui.origin })
  t.after(async () => {
    await instanceA.server.stop()
    await instanceB.server.stop()
    await gui.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const opened = instanceA.server.openPairing({ relationship: 'same-account', scope: defaultScope('same-account') })
  assert.match(opened.code, /^\d{8}$/)
  assert.ok(instanceA.server.info().pairingOpen)

  const connectorB = createConnector({ store: instanceB.store, log: silentLog })
  const peerA = await connectorB.claim(instanceA.base, opened.code)
  assert.equal(peerA.name, 'machine-a')
  assert.ok(peerA.token.length > 20)
  const view = await connectorB.sync(peerA)
  assert.equal(view.online, true)
  assert.equal(instanceA.server.trusted().length, 1)

  const { url } = await connectorB.access(peerA)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/dl\/enter\?ac=/)
  const enter = await fetch(url, { redirect: 'manual' })
  assert.equal(enter.status, 302)
  const setCookie = enter.headers.getSetCookie().join('; ')
  assert.match(setCookie, /dl_session=/)
  const sessionCookie = setCookie.split(';')[0]

  const reuse = await fetch(url, { redirect: 'manual' })
  assert.equal(reuse.status, 401)

  const page = await fetch(`${instanceA.base}/`, { headers: { cookie: sessionCookie } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /fake remote gui/)
  assert.equal(page.headers.getSetCookie().length, 0, 'owner cookie must not leak to the device')

  const api = await fetch(`${instanceA.base}/api/data`, { headers: { cookie: sessionCookie } })
  assert.equal(api.status, 200)
  const payload = await api.json()
  assert.equal(payload.ok, true)
  assert.match(payload.cookie, /sid=owner-1/)

  const { port } = instanceA.listen
  const upgrade = await upgradeEcho('127.0.0.1', port, sessionCookie)
  assert.match(upgrade, /101 Switching Protocols/)
  assert.match(upgrade, /ECHO:cookie=.*sid=owner-1/)

  await connectorB.revoke(peerA)
  assert.equal(instanceA.server.trusted().length, 0)
  const afterRevoke = await fetch(`${instanceA.base}/dl/info`)
  assert.equal(afterRevoke.status, 200)
  const denied = await fetch(`${instanceA.base}/`, { headers: { cookie: sessionCookie } })
  assert.equal(denied.status, 401)
})
