import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorkspaceFact, ModelSelection, ModelCatalog } from './types.js'

export interface HostMessage { role: string; content: unknown; source?: Record<string, unknown> }
export interface HostEvent { type: string; seq: number; time?: number; data: Record<string, unknown> }
export interface HostSession {
  id: string
  header: { id?: string; cwd?: string; createdAt?: number | string }
  title?: string
  updatedAt?: number
  seq: number
  snapshotEvents(from?: number, to?: number): HostEvent[]
  deriveMessages(): HostMessage[]
}
export interface HostAgent {
  id: string
  status: string
  session: HostSession
  options: { model?: string; provider?: string }
  inbox?: { nextTurn: HostMessage[]; nextStep: HostMessage[] }
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  timeoutMs?: number
  isConcurrencySafe(): boolean
  execute(args: Record<string, unknown>, execution?: { callId: string; signal: AbortSignal; agent?: HostAgent }): Promise<unknown>
}
export interface HostServices {
  workspaceRegistry: { list(): WorkspaceFact[] }
  sessions: { list(): HostSession[]; get(id: string): HostSession | undefined }
  agents: { list(): HostAgent[]; get(id: string): HostAgent | undefined }
  agentDefaultModel: { currentSelection(): { provider?: string; model?: string } }
  permissionPresets: { set(session: HostSession, preset: string): void }
  sandboxPolicy: { resolve(request: { session: HostSession }): { mode: string; workspaceRoot: string } }
  sessionController: {
    modelCatalog?(): Promise<ModelCatalog>
    /** Harness 0.2.1 session-scoped admission; public selectModel also saves a device default. */
    agents?: {
      selectionFor(agent: HostAgent): { current: ModelSelection }
      selectForNextRequest(agent: HostAgent, selection: ModelSelection): void
      serializeImageAdmission<T>(agent: HostAgent, operation: () => Promise<T>): Promise<T>
    }
    create(request: { sessionId: string; cwd: string }): Promise<{ sessionId: string }>
    prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    cancel(request: { sessionId: string }): Promise<unknown>
    resolveAgent?(sessionId: string): Promise<{ agent?: HostAgent; error?: { message?: string } }>
  }
  llm: { resolveCallConfig(selection: ModelSelection): Promise<ModelSelection> }
  sessionQuery: {
    listSessions(): Promise<{ header: HostSession['header']; live: boolean }[]>
    readSession(id: string): Promise<{ session: HostSession['header']; events: HostEvent[] }>
  }
  tools: { register(definition: ToolDefinition): () => void }
  systemPrompt: { section(definition: { name: string; order: number; text(): string }): () => void }
}
export interface HostContext {
  get<K extends keyof HostServices>(name: K): HostServices[K] | undefined
  effect(factory: () => (() => void) | void): void
  webServer: {
    getOrigin(): string
    register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void
  }
  connection: {
    authenticatedUrl(origin?: string): string
    requestRejection(request: { headers: IncomingMessage['headers'] }): number | undefined
  }
  commands: {
    register(command: { name: string; description: string; input: { hint: string }; handler(invocation: { rawInput: string }): Promise<{ kind: string; text: string }> }): () => void
  }
}

export function service<K extends keyof HostServices>(ctx: Pick<HostContext, 'get'>, name: K): HostServices[K] | undefined {
  try { return ctx.get(name) } catch { return undefined }
}
