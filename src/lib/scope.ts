import path from 'node:path'
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { HttpError, record, type Scope, type WorkspaceScope, type AccountRelation } from './types.js'

export function defaultScope(relationship: AccountRelation): Scope {
  const same = relationship === 'same-account'
  return { workspaces: same ? 'all' : [], allowUi: same, allowDelegate: same, sessionSync: same ? 'content' : 'none', sessionIds: 'all', allowReadFiles: same, sessionTools: false }
}

/** An owner supplies the complete grant. A malformed value never expands access. */
export function normalizeScope(value: unknown): Scope {
  const input = record(value)
  const workspaces = input.workspaces
  if (workspaces !== 'all' && (!Array.isArray(workspaces) || !workspaces.every(item => typeof item === 'string' && path.isAbsolute(item)))) {
    throw new HttpError(400, 'workspaces must be all or an array of absolute paths')
  }
  if (typeof input.allowUi !== 'boolean' || typeof input.allowDelegate !== 'boolean'
    || typeof input.allowReadFiles !== 'boolean' || typeof input.sessionTools !== 'boolean') {
    throw new HttpError(400, 'allowUi, allowDelegate, allowReadFiles and sessionTools must be boolean')
  }
  if (typeof input.sessionSync !== 'string' || !['none', 'metadata', 'content'].includes(input.sessionSync)) throw new HttpError(400, 'invalid sessionSync')
  if (input.sessionIds !== 'all' && (!Array.isArray(input.sessionIds) || !input.sessionIds.every(id => typeof id === 'string' && id.length > 0))) {
    throw new HttpError(400, 'sessionIds must be all or an array of session ids')
  }
  const scope: Scope = {
    workspaces: workspaces === 'all' ? 'all' : [...new Set((workspaces as string[]).map(item => path.resolve(item)))],
    allowUi: input.allowUi,
    allowDelegate: input.allowDelegate,
    sessionSync: input.sessionSync as Scope['sessionSync'],
    sessionIds: input.sessionIds as Scope['sessionIds'],
    allowReadFiles: input.allowReadFiles,
    sessionTools: input.sessionTools && input.sessionSync === 'content',
  }
  if (scope.allowUi && (scope.workspaces !== 'all' || scope.sessionSync !== 'content' || scope.sessionIds !== 'all')) {
    throw new HttpError(400, '完整界面需要全部工作区与全部会话内容授权')
  }
  return scope
}

export function isPathAllowed(value: unknown, allowed: WorkspaceScope = 'all'): boolean {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false
  if (allowed === 'all') return true
  if (!Array.isArray(allowed)) return false
  const target = path.resolve(value)
  return allowed.some(base => {
    if (!path.isAbsolute(base)) return false
    const relative = path.relative(path.resolve(base), target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

/** Host and task paths can be resolved while owner-entered grant roots retain aliases. */
export function isResolvedPathAllowed(value: string, allowed: WorkspaceScope = 'all'): boolean {
  if (isPathAllowed(value, allowed)) return true
  if (allowed === 'all') return false
  return allowed.some(base => {
    try { return isPathAllowed(value, [realpathSync(base)]) } catch { return false }
  })
}

/** Check real paths immediately before execution so symlinks cannot widen the grant. */
export async function authorizedWorkspace(value: string, scope: Scope): Promise<string> {
  if (!isResolvedPathAllowed(value, scope.workspaces)) throw new HttpError(403, 'workspace is outside the grant', 'scope')
  const resolved = await fs.realpath(value).catch(() => { throw new HttpError(400, 'workspace directory does not exist') })
  if (!(await fs.stat(resolved)).isDirectory()) throw new HttpError(400, 'workspace must be a directory')
  const allowed = scope.workspaces === 'all' ? 'all' : await Promise.all(scope.workspaces.map(base => fs.realpath(base)))
  if (!isPathAllowed(resolved, allowed)) throw new HttpError(403, 'workspace resolves outside the grant', 'scope')
  return resolved
}

export function sessionAllowed(session: { id: string; cwd: string }, scope: Scope): boolean {
  return scope.sessionSync !== 'none' && isResolvedPathAllowed(session.cwd, scope.workspaces)
    && (scope.sessionIds === 'all' || scope.sessionIds.includes(session.id))
}
