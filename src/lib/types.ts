export const APP_VERSION = '0.2.0'
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
export interface AgentFact { id: string; cwd: string; status: string; model?: string; provider?: string }
export interface SessionMessage { role: 'user' | 'assistant'; text: string }
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
}
export interface Store {
  path: string
  directory: string
  load(): Promise<State>
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
  timeoutMs?: number
  signal?: AbortSignal
  confineWorkspace?: boolean
}
export interface DelegateResult {
  status: 'completed' | 'timeout' | 'error'
  sessionId: string
  text: string
  error?: string
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
