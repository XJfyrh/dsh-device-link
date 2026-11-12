import path from 'node:path'
import { service, type HostContext, type HostEvent, type HostAgent } from './host.js'
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
      used = parseSelection(record(event.data.header).config)
      if (sameSelection(used, pending)) pending = undefined
    }
  }
  return pending ?? used
}
export function currentSelection(ctx: Pick<HostContext, 'get'>, agent: HostAgent): ModelSelection | undefined {
  return service(ctx, 'sessionController')?.agents?.selectionFor(agent).current
    ?? eventSelection(agent.session.snapshotEvents())
}
export async function executionContext(ctx: Pick<HostContext, 'get'>, workspace: string, sessionId?: string): Promise<ExecutionContext> {
  const controller = service(ctx, 'sessionController')
  if (!controller?.modelCatalog) throw new HttpError(503, '执行设备未提供模型目录')
  const catalog = await controller.modelCatalog()
  let selected = catalog.default
  const agent = sessionId ? service(ctx, 'agents')?.get(sessionId) : undefined
  if (sessionId) {
    const live = service(ctx, 'sessions')?.get(sessionId)
    const saved = live ? { session: live.header, events: live.snapshotEvents() } : await service(ctx, 'sessionQuery')?.readSession(sessionId)
    if (!saved) throw new HttpError(404, '设备会话已不存在')
    if (path.resolve(saved.session.cwd ?? '') !== path.resolve(workspace)) throw new HttpError(403, '会话不属于此工作区')
    selected = (agent ? currentSelection(ctx, agent) : eventSelection(saved.events)) ?? selected
  }
  // Explicit whitelist: provider credentials and host configuration never cross this endpoint.
  return { catalog: { default: catalog.default, groups: catalog.groups.map(group => ({ id: group.id, name: group.name,
    models: group.models.map(model => ({ id: model.id, name: model.name, reasoning: model.reasoning && {
      efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })), defaultEffort: model.reasoning.defaultEffort,
    } })) })), failures: catalog.failures.map(item => ({ id: item.id, name: item.name, message: '模型目录暂时不可用' })) }, selected, busy: agent?.status === 'running' }
}
export async function selectForTask(ctx: Pick<HostContext, 'get'>, agent: HostAgent, selection: ModelSelection): Promise<void> {
  const controller = service(ctx, 'sessionController')
  const admission = controller?.agents
  if (!controller?.modelCatalog || !admission) throw new HttpError(503, '执行设备未提供会话模型选择')
  const catalog = await controller.modelCatalog()
  const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
  if (!model) throw new HttpError(409, '所选模型已不可用，请重新选择')
  if (selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new HttpError(409, '所选思考强度已不可用，请重新选择')
  const resolver = service(ctx, 'llm')
  if (!resolver) throw new HttpError(503, '执行设备模型服务不可用')
  const resolved = await resolver.resolveCallConfig(selection)
  await admission.serializeImageAdmission(agent, async () => {
    if (agent.status === 'running') throw new HttpError(409, '设备会话正在执行任务，请稍后发送')
    admission.selectForNextRequest(agent, { provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: String(resolved.reasoningEffort) } : {}) })
  })
}
