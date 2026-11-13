import path from 'node:path'
import type { HostContext, HostEvent, HostAgent } from './host.js'
import { HttpError, record, type ModelSelection, type ExecutionContext } from './types.js'

export function parseSelection(value: unknown): ModelSelection | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  if (typeof input.provider !== 'string' || !input.provider || typeof input.model !== 'string' || !input.model
    || (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== 'string' || !input.reasoningEffort))) throw new HttpError(400, '模型选择无效')
  return { provider: input.provider, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: String(input.reasoningEffort) } : {}) }
}
export function sameSelection(a?: ModelSelection, b?: ModelSelection): boolean {
  return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
}
export function eventSelection(events: HostEvent[]): ModelSelection | undefined {
  let pending: ModelSelection | undefined
  let used: ModelSelection | undefined
  for (const event of events) {
    if (event.type === 'model/selection') pending = parseSelection(event.data)
    if (event.type === 'request/header') {
      const header = record(event.data.header)
      used = parseSelection(header.config)
      // Adapter defaults describe execution, not an explicit choice for the next prompt.
      if (used && record(header.adapterDefaults).reasoningEffort === true) delete used.reasoningEffort
      if (sameSelection(used, pending)) pending = undefined
    }
  }
  return pending ?? used
}
export async function executionContext(ctx: Pick<HostContext, 'get'>, workspace: string, sessionId?: string): Promise<ExecutionContext> {
  const controller = ctx.get('sessionController')
  if (!controller) throw new HttpError(503, '执行设备未提供模型目录')
  const catalog = await controller.modelCatalog()
  let selected = catalog.default
  const agent = sessionId ? ctx.get('agents')?.get(sessionId) : undefined
  if (sessionId) {
    const live = ctx.get('sessions')?.get(sessionId)
    const saved = live ? { session: live.header, events: live.snapshotEvents() } : await ctx.get('sessionQuery')?.readSession(sessionId)
    if (!saved) throw new HttpError(404, '设备会话已不存在')
    if (path.resolve(saved.session.cwd ?? '') !== path.resolve(workspace)) throw new HttpError(403, '会话不属于此工作区')
    selected = (agent ? agent.model.current() : eventSelection(saved.events)) ?? selected
  }
  // Explicit whitelist: provider credentials and host configuration never cross this endpoint.
  return { catalog: { default: catalog.default, groups: catalog.groups.map(group => ({ id: group.id, name: group.name,
    models: group.models.map(model => ({ id: model.id, name: model.name, reasoning: model.reasoning && {
      efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })), defaultEffort: model.reasoning.defaultEffort,
    } })) })), failures: catalog.failures.map(item => ({ id: item.id, name: item.name, message: '模型目录暂时不可用' })) }, selected, busy: agent?.status === 'running' }
}
export async function selectForTask(ctx: Pick<HostContext, 'get'>, agent: HostAgent, selection: ModelSelection): Promise<void> {
  const controller = ctx.get('sessionController')
  if (!controller) throw new HttpError(503, '执行设备未提供会话模型选择')
  const admission = controller.agents
  const catalog = await controller.modelCatalog()
  const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
  if (!model) throw new HttpError(409, '所选模型已不可用，请重新选择')
  if (selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new HttpError(409, '所选思考强度已不可用，请重新选择')
  const resolver = ctx.get('llm')
  if (!resolver) throw new HttpError(503, '执行设备模型服务不可用')
  const resolved = await resolver.resolveCallConfig(selection)
  await admission.serializeImageAdmission(agent, async () => {
    if (agent.status === 'running') throw new HttpError(409, '设备会话正在执行任务，请稍后发送')
    agent.model.select({ provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: String(resolved.reasoningEffort) } : {}) })
  })
}
