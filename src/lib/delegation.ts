import crypto from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { service, type HostContext, type HostEvent } from './host.js'
import { lastAssistantText, contentText } from './host-facts.js'
import { currentSelection, selectForTask, parseSelection } from './models.js'
import { type DelegateInput, type DelegateResult, type Logger, HttpError, errorMessage, record } from './types.js'
export { lastAssistantText } from './host-facts.js'

function requestTurn(events: HostEvent[], baseline: number, requestId: string): unknown {
  let turn: unknown
  for (const event of events) {
    if (event.seq < baseline) continue
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'user/message' && record(event.data.source).rpcId === requestId) return turn
  }
  return undefined
}

export function delegationEnd(events: HostEvent[], baseline: number, requestId?: string): HostEvent | undefined {
  const turn = requestId ? requestTurn(events, baseline, requestId) : undefined
  if (requestId && turn === undefined) return undefined
  return events.find(event => event.type === 'turn/end' && event.seq >= baseline && (!requestId || event.data.turn === turn))
}

export function delegationText(events: HostEvent[], baseline: number, requestId: string): string {
  const turn = requestTurn(events, baseline, requestId)
  if (turn === undefined) return ''
  for (const event of [...events].reverse()) {
    if (event.seq >= baseline && event.type === 'assistant/message' && event.data.turn === turn) {
      const text = contentText(record(event.data.message).content)
      if (text) return text.slice(-64_000)
    }
  }
  return ''
}

/** Use the same session creation and prompt admission services as the Harness UI. */
export function createDelegationRunner({ ctx, log = console }: { ctx: Pick<HostContext, 'get'>; log?: Logger }) {
  const running = new Map<string, AbortController>()
  let disposed = false

  async function run(input: DelegateInput): Promise<DelegateResult> {
    if (!path.isAbsolute(input.workspacePath) || !input.task.trim()) throw new HttpError(400, 'absolute workspacePath and task required')
    const controller = service(ctx, 'sessionController')
    if (!controller) throw new HttpError(503, 'Harness sessionController service unavailable')
    if (disposed) throw new HttpError(503, 'device-link is stopping')
    let sessionId = input.sessionId ?? `delegate-${crypto.randomUUID()}`
    const abort = new AbortController()
    const signal = input.signal ? AbortSignal.any([abort.signal, input.signal]) : abort.signal
    running.set(sessionId, abort)
    const key = sessionId
    const deadline = Date.now() + (input.timeoutMs ?? 300_000)
    try {
      signal.throwIfAborted()
      if (input.resume) {
        if (!controller.resolveAgent) throw new Error('Harness session resume service unavailable')
        const resumed = await controller.resolveAgent(sessionId)
        if (!resumed.agent) throw new Error(resumed.error?.message ?? 'remote session could not be resumed')
        if (resumed.agent.status === 'running') throw new HttpError(409, '设备会话正在执行任务，请等待当前任务结束')
        if (path.resolve(resumed.agent.session.header.cwd ?? '') !== path.resolve(input.workspacePath)) throw new Error('session workspace does not match the delegated workspace')
      } else {
        const created = await controller.create({ sessionId, cwd: input.workspacePath })
        sessionId = created.sessionId
      }
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
      const agent = service(ctx, 'agents')?.get(sessionId)
      if (input.selection) {
        if (!agent) throw new Error('设备会话未就绪')
        await selectForTask(ctx, agent, input.selection)
        signal.throwIfAborted()
      }
      if (agent?.status === 'running') throw new HttpError(409, '设备会话正在执行任务，请稍后发送')
      let model = agent ? currentSelection(ctx, agent) ?? agent.options : undefined
      await input.onProgress?.({ sessionId, baselineSeq: baseline, text: '', provider: model?.provider, model: model?.model })
      await controller.prompt({ requestId: input.requestId ?? crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: input.task }] }, signal)
      let lastProgress = ''
      let nextProgress = Date.now() + 1000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const events = session.snapshotEvents()
        const used = [...events].reverse().find(event => event.seq >= baseline && event.type === 'request/header')
        if (used) model = parseSelection(record(used.data.header).config) ?? model
        const end = delegationEnd(events, baseline, input.requestId)
        if (end) {
          await input.onProgress?.({ sessionId, baselineSeq: baseline, text: input.requestId ? delegationText(events, baseline, input.requestId) : lastAssistantText(session.deriveMessages()), ...model })
          const reason = record(end.data.reason)
          if (reason.kind !== 'completed') throw new Error(String(record(reason.error).message ?? `turn ended with ${reason.kind}`))
          return { status: 'completed', sessionId, text: input.requestId ? delegationText(events, baseline, input.requestId) : lastAssistantText(session.deriveMessages()) }
        }
        if (input.requestId && agent?.status === 'idle' && agent.inbox
          && ![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source?.rpcId === input.requestId)) {
          const failed = events.find(event => event.seq >= baseline && event.type === 'turn/end' && record(event.data.reason).kind !== 'completed')
          if (failed) throw new Error(String(record(record(failed.data.reason).error).message ?? '设备任务在执行前结束'))
        }
        if (input.onProgress && Date.now() >= nextProgress) {
          const text = input.requestId ? delegationText(events, baseline, input.requestId) : lastAssistantText(session.deriveMessages()).slice(-64_000)
          if (text !== lastProgress) {
            await input.onProgress({ sessionId, baselineSeq: baseline, text, ...model })
            lastProgress = text
          }
          nextProgress = Date.now() + 1000
        }
        await delay(100, undefined, { signal })
      }
      // A timed-out task remains observable in the remote session list.
      return { status: 'timeout', sessionId, text: '' }
    } catch (error) {
      if (signal.aborted) {
        try {
          await controller.cancel({ sessionId })
          const events = service(ctx, 'sessions')?.get(sessionId)?.snapshotEvents() ?? []
          const end = input.requestId ? delegationEnd(events, 0, input.requestId) : undefined
          if (end && record(end.data.reason).kind === 'completed') return { status: 'completed', sessionId, text: delegationText(events, 0, input.requestId!) }
          return { status: 'error', sessionId, text: '', error: errorMessage(error), cancelled: true }
        } catch (cause) {
          log.warn?.(errorMessage(cause))
          return { status: 'error', sessionId, text: '', error: `${errorMessage(error)}; cancellation failed: ${errorMessage(cause)}` }
        }
      }
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
