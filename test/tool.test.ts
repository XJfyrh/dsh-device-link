import test from 'node:test'
import assert from 'node:assert/strict'
import { registerDeviceTools } from '../src/lib/tool.ts'
import type { ToolDefinition } from '../src/lib/host.ts'

test('device tools return lossless JSON when optional result and cache fields are absent', async () => {
  const registered = new Map<string, ToolDefinition>()
  const task = { id: 'task', deviceName: 'remote', workspacePath: '/workspace', submission: 'pending' }
  const runtime = {
    store: { state: () => ({ peers: {} }) },
    connector: { peerByRef: () => ({ name: 'remote', deviceId: 'remote' }) },
    outgoingTasks: { start: async () => task, wait: async () => task, refresh: async () => task, cancel: async () => task },
  }
  const dispose = registerDeviceTools({ get: name => name === 'tools' ? { register(definition) { registered.set(definition.name, definition); return () => {} } } : undefined } as never, { load: async () => runtime as never })
  try {
    for (const [name, args] of [
      ['device_delegate', { device: 'remote', workspace: '/workspace', task: 'hello' }],
      ['device_task', { taskId: 'task' }],
      ['device_sessions', { device: 'remote' }],
    ] as const) {
      const result = await registered.get(name)!.execute(args)
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result, name)
    }
  } finally { dispose() }
})
