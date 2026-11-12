import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { type Logger, type State, type Store, errorMessage } from './types.js'

export const STORE_VERSION = 2
export function dshHome(): string { return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh') }
export function storeDir(home = dshHome()): string { return path.join(home, 'device-link') }
export function storeFile(home = dshHome()): string { return path.join(storeDir(home), 'devices-v2.json') }

function newState(deviceName?: string): State {
  return {
    version: STORE_VERSION,
    identity: { deviceId: crypto.randomBytes(16).toString('hex'), name: deviceName || os.hostname(), createdAt: new Date().toISOString() },
    serve: { port: 47654, bindAddress: 'auto', allowIncoming: true, lastAddress: '' },
    trusted: {}, peers: {}, favorites: [], incomingTasks: {}, outgoingTasks: {}, taskCancellations: {},
  }
}

export async function openStore({ home, log = console, deviceName }: { home?: string; log?: Logger; deviceName?: string } = {}): Promise<Store> {
  const directory = storeDir(home)
  const file = storeFile(home)
  await fs.mkdir(directory, { recursive: true })
  let state = newState(deviceName)
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as State
    if (parsed.version !== STORE_VERSION || !parsed.identity?.deviceId || !parsed.serve || !parsed.trusted || !parsed.peers) {
      throw new Error('invalid v2 device store')
    }
    state = { ...parsed, favorites: parsed.favorites ?? [], incomingTasks: parsed.incomingTasks ?? {}, outgoingTasks: parsed.outgoingTasks ?? {}, taskCancellations: parsed.taskCancellations ?? {} }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      log.warn?.(`device store backed up after read failure: ${errorMessage(error)}`)
    }
  }
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
    async load() { return structuredClone(state) },
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
