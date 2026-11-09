import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

test('@ input source offers cached workspace/session references without probing an offline peer', async () => {
  const source = await fs.readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
  const compiled = transformSync(source, { loader: 'tsx', format: 'iife' }).code
  let plugin
  let trigger
  const routes: string[] = []
  vm.runInNewContext(compiled, {
    window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(() => ({})) } } },
    fetch: async route => {
      routes.push(route)
      return { ok: true, json: async () => ({ ok: true, peers: [{ deviceId: 'remote', name: 'Lab PC', online: false, cachedAt: '2026-11-09T00:00:00Z', cachedSessionIds: ['session-1'], status: { host: {
        workspaces: [{ id: 'w', title: 'My Project', path: '/My Project' }],
        sessions: [{ id: 'session-1', title: 'Cached work' }, { id: 'session-2', title: 'Metadata only' }],
      } } }] }) }
    },
  })
  plugin.apply({ slots: { inject(_name, callback) { callback() }, register() {} }, effect(factory) { factory() }, inputTriggers: { registerSource(value) { trigger = value; return () => {} } } })
  assert.equal(trigger.trigger, '@')
  const candidates = await trigger.candidates({}, { query: 'Lab', signal: new AbortController().signal })
  assert.equal(candidates.length, 2)
  assert.deepEqual(routes, ['/device-link/api/references'])
  assert.match(candidates[0].value, /path=%2FMy%20Project/)
  assert.match(trigger.onPick({ candidate: candidates[1] }).text, /^@device:\/\/remote\/session\?id=session-1 /)
})
