import test from 'node:test'
import assert from 'node:assert/strict'
import { registerDeviceCommands } from '../src/lib/commands.ts'
import type { HostContext } from '../src/lib/host.ts'
import type { Runtime } from '../src/index.ts'

function fixture() {
  let command: Parameters<HostContext['commands']['register']>[0] | undefined
  const revoked: string[] = []
  const submitted: { workspacePath: string; task: string }[] = []
  const runtime = {
    store: { state: () => ({ identity: { deviceId: 'local' } }) },
    server: {
      info: () => ({ allowIncoming: true }),
      trusted: () => [{ deviceId: 'a', name: 'shared' }, { deviceId: 'b', name: 'shared' }],
      revoke: async (id: string) => { revoked.push(id); return true },
    },
    connector: {
      peerByRef: (reference: string) => ['peer', 'peer with spaces'].includes(reference) ? { deviceId: 'peer' } : undefined,
      cachedSession: (_peer: unknown, id: string) => ({ id }),
    },
    outgoingTasks: { start: async (_peer: unknown, input: { workspacePath: string; task: string }) => { submitted.push(input); return { id: 'task' } } },
  }
  const ctx = { commands: { register(value: NonNullable<typeof command>) { command = value; return () => {} } } }
  registerDeviceCommands(ctx as HostContext, { load: async () => runtime as unknown as Runtime })
  assert.ok(command)
  const registered = command
  return { run: (rawInput: string) => registered.handler({ rawInput }), revoked, submitted }
}

test('device command accepts empty status and trims delegate input consistently', async () => {
  const { run, submitted } = fixture()
  const status = await run('   ')
  assert.equal(status.kind, 'success')
  assert.equal(JSON.parse(status.text).identity.deviceId, 'local')
  assert.equal((await run('  delegate peer | E:\\workspace | task | details  ')).kind, 'success')
  assert.equal(submitted[0].workspacePath, 'E:\\workspace')
  assert.equal(submitted[0].task, 'task|details')
  const session = await run('session peer with spaces session-id')
  assert.equal(session.kind, 'success')
  assert.equal(JSON.parse(session.text).id, 'session-id')
})

test('untrust rejects ambiguous names and revokes only the explicitly selected device id', async () => {
  const { run, revoked } = fixture()
  const ambiguous = await run('untrust shared')
  assert.equal(ambiguous.kind, 'error')
  assert.match(ambiguous.text, /名称不唯一/)
  assert.deepEqual(revoked, [])
  assert.equal((await run('untrust b')).kind, 'success')
  assert.deepEqual(revoked, ['b'])
})
