import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../src/lib/store.ts'
import { registerDeviceApi } from '../src/lib/api.ts'
import type { HostContext } from '../src/lib/host.ts'
import type { Runtime } from '../src/index.ts'

test('long default hostnames allow initialization and saved identities ignore changed defaults', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-long-name-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()))
    await fs.rm(home, { recursive: true, force: true })
  })
  t.mock.method(os, 'hostname', () => 'runner-'.repeat(20))
  const store = await openStore({ home })
  assert.equal(store.state().identity.name, 'runner-'.repeat(20).slice(0, 64))
  const reopened = await openStore({ home, deviceName: 'x'.repeat(65) })
  assert.deepEqual(reopened.state().identity, store.state().identity)
  await assert.rejects(openStore({ home: path.join(home, 'explicit'), deviceName: 'x'.repeat(65) }), /64/)
  t.mock.method(os, 'hostname', () => 'a'.repeat(63) + '🖥️')
  const unicode = await openStore({ home: path.join(home, 'unicode') })
  assert.equal(unicode.state().identity.name, 'a'.repeat(63))
})

test('owner rename API validates and durably saves the name without changing identity', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'device-name-api-'))
  const store = await openStore({ home, deviceName: 'Initial' })
  const original = store.state().identity
  let handler: Parameters<HostContext['webServer']['register']>[0]['handler']
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {} } },
    connection: { requestRejection({ headers }) { return headers.authorization === 'Bearer owner-test' ? undefined : 401 } },
  } as HostContext
  registerDeviceApi(ctx, { load: async () => ({ store }) as Runtime })
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()))
    await fs.rm(home, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/device-link/api/rename`
  const post = (name: unknown, authenticated = true) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer owner-test' } : {}) }, body: JSON.stringify({ name }) })
  assert.equal((await post('Unauthorized', false)).status, 401)
  assert.equal((await post(' ')).status, 400)
  assert.equal((await post('x'.repeat(65))).status, 400)
  assert.equal((await post('\ud800')).status, 400)
  assert.equal((await post('\udfff')).status, 400)
  assert.deepEqual(store.state().identity, original)
  const response = await post('  测试电脑 🖥️  ')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).identity, { ...original, name: '测试电脑 🖥️' })
  const reopened = await openStore({ home, deviceName: 'Initial' })
  assert.deepEqual(reopened.state().identity, { ...original, name: '测试电脑 🖥️' })
})
