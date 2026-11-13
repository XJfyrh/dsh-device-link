import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { type Logger, type State, type Store, errorMessage } from './types.js'
import { normalizeDeviceName } from './identity.js'

export const STORE_VERSION = 2
export function dshHome(): string { return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh') }
export function storeDir(home = dshHome()): string { return path.join(home, 'device-link') }
export function storeFile(home = dshHome()): string { return path.join(storeDir(home), 'devices-v2.json') }

function newState(deviceName?: string): State {
  return {
    version: STORE_VERSION,
    identity: { deviceId: crypto.randomBytes(16).toString('hex'), name: normalizeDeviceName(deviceName || os.hostname().slice(0, 64).replace(/[\ud800-\udbff]$/u, '')), createdAt: new Date().toISOString() },
    serve: { port: 47654, bindAddress: 'auto', allowIncoming: true, lastAddress: '' },
    trusted: {}, peers: {}, favorites: [], incomingTasks: {}, outgoingTasks: {}, taskCancellations: {},
  }
}

function parseState(source: string): State {
  const parsed: unknown = JSON.parse(source)
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(parsed) || parsed.version !== STORE_VERSION
    || !object(parsed.identity) || typeof parsed.identity.deviceId !== 'string' || !parsed.identity.deviceId
    || typeof parsed.identity.name !== 'string' || typeof parsed.identity.createdAt !== 'string'
    || !object(parsed.serve) || typeof parsed.serve.port !== 'number' || typeof parsed.serve.bindAddress !== 'string'
    || typeof parsed.serve.allowIncoming !== 'boolean' || typeof parsed.serve.lastAddress !== 'string'
    || !object(parsed.trusted) || !object(parsed.peers) || !Array.isArray(parsed.favorites)
    || !object(parsed.incomingTasks) || !object(parsed.outgoingTasks) || !object(parsed.taskCancellations)) {
    throw new Error('device store does not match the current schema')
  }
  return parsed as unknown as State
}

export async function openStore({ home, log = console, deviceName }: { home?: string; log?: Logger; deviceName?: string } = {}): Promise<Store> {
  const directory = storeDir(home)
  const file = storeFile(home)
  await fs.mkdir(directory, { recursive: true })
  let state: State
  let source: string | undefined
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (source !== undefined) {
    try { state = parseState(source) } catch (error) {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      log.warn?.(`device store backed up after validation failure: ${errorMessage(error)}`)
      state = newState(deviceName)
    }
  } else state = newState(deviceName)
  async function save(value: State): Promise<void> {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  await save(state)
  let queue = Promise.resolve()
  return {
    path: file, directory,
    state() { return structuredClone(state) },
    update(mutator) {
      const operation = queue.then(async () => {
        const draft = structuredClone(state)
        await mutator(draft)
        await save(draft)
        state = draft
        return structuredClone(state)
      })
      queue = operation.then(() => {}, () => {})
      return operation
    },
  }
}
