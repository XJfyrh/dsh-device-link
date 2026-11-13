import test from 'node:test'
import assert from 'node:assert/strict'
import { statePayload } from '../src/lib/api.ts'
import type { Runtime } from '../src/index.ts'

test('owner state remains available and reports a failed background status write', async t => {
  const failure = new Error('device store write failed')
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  const peer = { deviceId: 'remote' }
  const cached = { deviceId: 'remote', online: false }
  const identity = { deviceId: 'local', name: 'Local' }
  const host = { workspaces: [] }
  const runtime = {
    server: { info: () => ({ allowIncoming: true }), pairingCode: () => null, addresses: () => [], trusted: () => [] },
    store: { state: () => ({ identity, peers: { remote: peer }, favorites: [] }) },
    connector: { sync: async () => { throw failure }, cachedView: () => cached },
    hostFacts: async () => host,
  } as unknown as Runtime
  const payload = await statePayload(runtime)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(payload.identity, identity)
  assert.deepEqual(payload.peers, [cached])
  assert.equal(payload.host, host)
  assert.deepEqual(warnings, [['[device-link] status sync', failure]])
})
