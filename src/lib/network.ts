import net from 'node:net'
import { lanAddresses, isPrivateIPv4 } from './config.js'
import { API_VERSION, APP_VERSION, HttpError, errorMessage } from './types.js'

export function normalizeBase(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  const match = /^(?:(https?):\/\/)?([^/:?#@\s]+)(?::(\d+))?\/?$/.exec(raw)
  if (!match) throw new HttpError(400, '请输入局域网 IPv4 地址与端口，例如 192.168.1.5:47654', 'address')
  const hostname = match[2] === 'localhost' ? '127.0.0.1' : match[2]
  if (!net.isIPv4(hostname)) throw new HttpError(400, '设备地址需要标准 IPv4，或用于本机测试的 localhost', 'address')
  const local = hostname.startsWith('127.') || isPrivateIPv4(hostname)
  if (!local) throw new HttpError(400, '地址需要位于私有局域网或本机回环网段', 'address')
  const port = match[3] ? Number(match[3]) : 47654
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '端口需要在 1–65535 之间', 'address')
  return `${match[1] || 'http'}://${hostname}:${port}`
}

export interface Diagnostic {
  ok: boolean
  stage: 'address' | 'tcp' | 'protocol' | 'ready'
  address?: string
  message: string
  elapsedMs: number
  interfaces: { name: string; address: string }[]
  device?: { deviceId: string; name: string; version: string; pairingOpen: boolean }
}

export async function diagnose(input: unknown): Promise<Diagnostic> {
  const started = Date.now()
  const interfaces = lanAddresses()
  let address: string
  try { address = normalizeBase(input) } catch (error) {
    return { ok: false, stage: 'address', message: errorMessage(error), elapsedMs: Date.now() - started, interfaces }
  }
  const url = new URL(address)
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
      socket.setTimeout(2500)
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('timeout', () => { socket.destroy(); reject(new Error('连接超时，请检查同一局域网、监听地址和防火墙端口')) })
      socket.once('error', reject)
    })
  } catch (error) {
    return { ok: false, stage: 'tcp', address, message: errorMessage(error), elapsedMs: Date.now() - started, interfaces }
  }
  try {
    const response = await fetch(`${address}/dl/info`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
    const info = await response.json() as Record<string, unknown>
    if (!response.ok || info.app !== 'dsh-device-link' || info.api !== API_VERSION) throw new Error(`端口可达，需要设备连接协议 ${API_VERSION}`)
    return { ok: true, stage: 'ready', address, message: info.pairingOpen ? '连接正常，配对码已开放' : '连接正常，请在对端生成配对码', elapsedMs: Date.now() - started, interfaces,
      device: { deviceId: String(info.deviceId), name: String(info.name), version: String(info.version), pairingOpen: Boolean(info.pairingOpen) } }
  } catch (error) {
    return { ok: false, stage: 'protocol', address, message: errorMessage(error), elapsedMs: Date.now() - started, interfaces }
  }
}

export function updateStatus(remoteVersion: string): 'current' | 'remote-newer' | 'remote-older' | 'unknown' {
  if (!/^\d+\.\d+\.\d+$/.test(remoteVersion)) return 'unknown'
  const remote = remoteVersion.split('.').map(Number)
  const local = APP_VERSION.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (remote[index] > local[index]) return 'remote-newer'
    if (remote[index] < local[index]) return 'remote-older'
  }
  return 'current'
}
