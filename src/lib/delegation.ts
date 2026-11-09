import crypto from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { service, type HostContext } from './host.js'
import { lastAssistantText } from './host-facts.js'
import { type DelegateInput, type DelegateResult, type Logger, HttpError, errorMessage, record } from './types.js'
export { lastAssistantText } from './host-facts.js'

/** Use the same session creation and prompt admission services as the Harness UI. */
export function createDelegationRunner({ ctx, log = console }: { ctx: Pick<HostContext, 'get'>; log?: Logger }) {
  const running = new Map<string, AbortController>()
  let disposed = false

  async function run(input: DelegateInput): Promise<DelegateResult> {
    if (!path.isAbsolute(input.workspacePath) || !input.task.trim()) throw new HttpError(400, 'absolute workspacePath and task required')
    const controller = service(ctx, 'sessionController')
    if (!controller) throw new HttpError(503, 'Harness sessionController service unavailable')
    if (disposed) throw new HttpError(503, 'device-link is stopping')
    let sessionId = `delegate-${crypto.randomUUID()}`
    const abort = new AbortController()
    const signal = input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal
    running.set(sessionId, abort)
    const key = sessionId
    const deadline = Date.now() + (input.timeoutMs ?? 300_000)
    try {
      signal.throwIfAborted()
      const created = await controller.create({ sessionId, cwd: input.workspacePath })
      sessionId = created.sessionId
      signal.throwIfAborted()
      const sessions = service(ctx, 'sessions')
      const session = sessions?.get(sessionId)
      if (!session) throw new Error('created session is unavailable')
      if (input.confineWorkspace) {
        const permissions = service(ctx, 'permissionPresets')
        const sandbox = service(ctx, 'sandboxPolicy')
        if (!permissions || !sandbox) throw new Error('workspace-scoped delegation requires Harness permissionPresets and sandboxPolicy')
        permissions.set(session, 'workspace-write')
        const policy = sandbox.resolve({ session })
        if (policy.mode !== 'workspace-write' || path.resolve(policy.workspaceRoot) !== path.resolve(input.workspacePath)) {
          throw new Error('Harness did not apply the delegated workspace sandbox')
        }
      }
      const baseline = session.seq
      await controller.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: input.task }] }, signal)
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const end = session.snapshotEvents().find(event => event.type === 'turn/end' && event.seq >= baseline)
        if (end) {
          const reason = record(end.data.reason)
          if (reason.kind !== 'completed') throw new Error(String(record(reason.error).message ?? `turn ended with ${reason.kind}`))
          return { status: 'completed', sessionId, text: lastAssistantText(session.deriveMessages()) }
        }
        await delay(100, undefined, { signal })
      }
      // A timed-out task remains observable in the remote session list.
      return { status: 'timeout', sessionId, text: '' }
    } catch (error) {
      if (signal.aborted) await controller.cancel({ sessionId }).catch(cause => log.warn?.(errorMessage(cause)))
      return { status: 'error', sessionId, text: '', error: errorMessage(error) }
    } finally {
      running.delete(key)
    }
  }

  async function disposeAll(): Promise<void> {
    disposed = true
    for (const abort of running.values()) abort.abort(new Error('device-link stopped'))
  }
  return { run, disposeAll }
}
