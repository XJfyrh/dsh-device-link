import test from 'node:test'
import assert from 'node:assert/strict'
import { registerDeviceTools } from '../src/lib/tool.ts'
import type { HostContext, HostServices, ToolDefinition } from '../src/lib/host.ts'
import type { OutgoingTask } from '../src/lib/types.ts'

test('task tools share pending input, error provenance and lossless JSON output', async () => {
  const registered = new Map<string, ToolDefinition>()
  const task: OutgoingTask = { id: 'task', deviceId: 'remote', deviceName: 'saved name', workspacePath: '/workspace',
    prompt: 'hello', createdAt: '', submission: 'pending' }
  const submittedIds: string[] = []
  const execution: NonNullable<Parameters<ToolDefinition['execute']>[1]> = { callId: 'call', signal: new AbortController().signal }
  const runtime = {
    store: { state: () => ({ peers: {} }) },
    connector: { peerByRef: () => ({ name: 'remote', deviceId: 'remote' }) },
    outgoingTasks: { start: async (_peer: unknown, input: { id: string }) => { submittedIds.push(input.id); return task },
      wait: async () => task, refresh: async () => task, cancel: async () => task },
  }
  const services: Partial<HostServices> = { tools: { register(definition) { registered.set(definition.name, definition); return () => {} } } }
  const ctx: Pick<HostContext, 'get'> = { get: name => services[name] }
  const dispose = registerDeviceTools(ctx, { load: async () => runtime as never })
  try {
    async function results() {
      return Promise.all([
        registered.get('device_delegate')!.execute({ device: 'remote', workspace: '/workspace', task: 'hello' }, execution),
        registered.get('device_task')!.execute({ taskId: 'task' }, execution),
      ]) as Promise<Record<string, unknown>[]>
    }
    for (const result of await results()) assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    task.remote = { id: 'task', sessionId: 'session', workspacePath: '/workspace', prompt: 'hello', status: 'running',
      createdAt: '', updatedAt: '', text: '', pendingInput: { kind: 'question' } }
    for (const result of await results()) {
      assert.deepEqual(result.pendingInput, { kind: 'question' })
      assert.match(String(result.nextAction), /不要重新委派/)
    }
    task.connectionError = 'offline'
    for (const result of await results()) {
      assert.equal(result.pendingInput, undefined)
      assert.equal(result.nextAction, undefined)
      assert.equal(result.errorOrigin, undefined)
    }
    delete task.connectionError
    delete task.remote.pendingInput
    task.remote.status = 'error'
    task.remote.error = 'remote failure with unknown stage'
    for (const [index, result] of (await results()).entries()) {
      assert.equal(result.errorOrigin, 'execution-device')
      assert.equal(result.executionDevice, index === 0 ? 'remote' : 'saved name')
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    }
    assert.equal(new Set(submittedIds).size, 1)
    const rootId = submittedIds[0]
    execution.agent = { id: 'local-session', status: 'running', options: {}, model: { current: () => undefined, select: () => {} },
      session: { id: 'local-session', header: {}, seq: 0, snapshotEvents: () => [] } }
    await results()
    await results()
    assert.notEqual(submittedIds.at(-1), rootId)
    assert.equal(submittedIds.at(-1), submittedIds.at(-2))
  } finally { dispose() }
})
