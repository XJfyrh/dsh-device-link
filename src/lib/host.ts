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
}
export interface HostAgent {
  id: string
  status: string
  session: HostSession
  options: { model?: string; provider?: string }
  model: { current(): ModelSelection | undefined; select(selection: ModelSelection): void }
  inbox?: { nextTurn: HostMessage[]; nextStep: HostMessage[] }
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  timeoutMs?: number
  isConcurrencySafe(): boolean
  execute(args: Record<string, unknown>, execution: { callId: string; signal: AbortSignal; agent?: HostAgent }): Promise<unknown>
}
export interface HostServices {
  workspaceRegistry: { list(): WorkspaceFact[] }
  workspaceController: { create(request: { path: string }): Promise<{ workspace: { workspaceId: string; path: string }; created: boolean }> }
  typertGateway: { getPendingRemoteEvents(): readonly { event: string; agentId: string | number }[] }
  sessions: { list(): HostSession[]; get(id: string): HostSession | undefined }
  agents: { list(): HostAgent[]; get(id: string): HostAgent | undefined }
  agentDefaultModel: { currentSelection(): { provider?: string; model?: string } }
  permissionPresets: { set(session: HostSession, preset: string): void }
  sandboxPolicy: { resolve(request: { session: HostSession }): { mode: string; workspaceRoot: string } }
  sessionController: {
    list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: { sessionId: string; cwd?: string; updatedAt: number; agentAvailable: boolean; projections?: { values: { title?: string | null } } }[] }>
    modelCatalog(): Promise<ModelCatalog>
    /** Public selectModel also changes the device default; delegated choices are session-local. */
    agents: {
      serializeImageAdmission<T>(agent: HostAgent, operation: () => Promise<T>): Promise<T>
    }
    create(request: { sessionId: string; workspaceId: string }): Promise<{ sessionId: string }>
    prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    cancel(request: { sessionId: string }): Promise<unknown>
    resolveAgent(sessionId: string): Promise<{ agent?: HostAgent; error?: { message?: string } }>
  }
  llm: { resolveCallConfig(selection: ModelSelection): Promise<ModelSelection> }
  sessionQuery: {
    listSessions(): Promise<{ header: HostSession['header']; live: boolean }[]>
    readSession(id: string): Promise<{ session: HostSession['header']; events: HostEvent[] }>
    readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<{ session: HostSession['header']; target: HostEvent; events: HostEvent[] }>
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
