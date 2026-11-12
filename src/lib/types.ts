export const APP_VERSION = '0.4.2'
export const API_VERSION = 'v2'

export type WorkspaceScope = 'all' | string[]
export type AccountRelation = 'same-account' | 'different-account' | 'unknown'
export interface Scope {
  workspaces: WorkspaceScope
  allowUi: boolean
  allowDelegate: boolean
  sessionSync: 'none' | 'metadata' | 'content'
  sessionIds: 'all' | string[]
}
export interface PairingGrant {
  relationship: AccountRelation
  scope: Scope
}
export interface Identity { deviceId: string; name: string; createdAt: string }
export interface TrustedDevice extends Identity, PairingGrant {
  tokenHash: string
  lastSeenAt: string
  active: boolean
}
export interface WorkspaceFact { id: string; path: string; title: string }
export interface SessionFact { id: string; title: string; cwd: string; updatedAt: number; live: boolean }
export interface AgentFact { id: string; title?: string; cwd: string; status: string; model?: string; provider?: string }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelCatalog {
  default: ModelSelection
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[]
  failures: { id: string; name: string; message: string }[]
}
export interface ExecutionContext { catalog: ModelCatalog; selected: ModelSelection; busy: boolean }
export interface SessionMessage { role: 'user' | 'assistant'; text: string; seq?: number; requestId?: string; turn?: number; timestamp?: number; selection?: ModelSelection }
export interface SessionContent extends SessionFact { messages: SessionMessage[]; truncated: boolean }
export interface CachedSession extends SessionContent { cachedAt: string }
export interface HostFacts {
  platform: string
  arch: string
  hostname: string
  node: string
  startedAt: number
  workspaces: WorkspaceFact[]
  sessions: SessionFact[]
  agents: AgentFact[]
  model: { provider?: string; model?: string }
}
export interface RemoteStatus {
  ok: true
  api: typeof API_VERSION
  device: { deviceId: string; name: string; app: string; version: string }
  scope: Scope
  host: HostFacts
}
export interface Peer extends Identity {
  baseUrl: string
  token: string
  lastSeenAt: string
  cache?: {
    syncedAt: string
    status: RemoteStatus
    sessions: Record<string, CachedSession>
  }
}
export interface State {
  version: 2
  identity: Identity
  serve: { port: number; bindAddress: string; allowIncoming: boolean; lastAddress: string }
  trusted: Record<string, TrustedDevice>
  peers: Record<string, Peer>
  favorites: FavoriteWorkspace[]
  incomingTasks: Record<string, StoredTask>
  outgoingTasks: Record<string, OutgoingTask>
  taskCancellations: Record<string, string>
}
export interface FavoriteWorkspace { deviceId: string; path: string; title: string }
export type TaskStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'error' | 'stopped' | 'interrupted'
export interface DeviceTask {
  id: string
  sessionId: string
  workspacePath: string
  prompt: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  text: string
  error?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  selection?: ModelSelection
  promptRequestId?: string
}
export interface StoredTask extends DeviceTask {
  ownerDeviceId: string
  tokenHash: string
  baselineSeq?: number
  resume: boolean
  promptRequestId: string
}
export interface OutgoingTask {
  id: string
  deviceId: string
  deviceName: string
  workspacePath: string
  prompt: string
  createdAt: string
  resumeSessionId?: string
  originSessionId?: string
  originCallId?: string
  remote?: DeviceTask
  checkedAt?: string
  connectionError?: string
  submission: 'pending' | 'accepted' | 'failed' | 'cancelled'
  cancelRequested?: boolean
  selection?: ModelSelection
}
export interface Store {
  path: string
  directory: string
  state(): State
  update(mutator: (draft: State) => void | Promise<void>): Promise<State>
}
export interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}
export interface DelegateInput {
  workspacePath: string
  task: string
  signal?: AbortSignal
  confineWorkspace?: boolean
  sessionId?: string
  resume?: boolean
  requestId: string
  selection?: ModelSelection
  onProgress?(progress: { sessionId: string; baselineSeq: number; text: string; provider?: string; model?: string; reasoningEffort?: string }): Promise<void>
}
export interface DelegateResult {
  status: 'completed' | 'error'
  sessionId: string
  text: string
  error?: string
  cancelled?: boolean
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export class HttpError extends Error {
  constructor(public status: number, message: string, public reason = 'invalid_request') {
    super(message)
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
