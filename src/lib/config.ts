import os from 'node:os'
import net from 'node:net'

export function isPrivateIPv4(address: string): boolean {
  if (!net.isIPv4(address)) return false
  const [first, second] = address.split('.').map(Number)
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31)
}

export const DEFAULTS = Object.freeze({
  allowIncoming: true,
  listenPort: 47654,
  bindAddress: 'auto',
  deviceName: '',
  pairingTtlMs: 120_000,
  accessTtlMs: 60_000,
  proxyRequestTimeoutMs: 30_000,
  toolsEnabled: true,
  maxPairFailures: 8,
  failureWindowMs: 10 * 60_000,
})

function asBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

function asPort(value: unknown, fallback: number) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback
}

function asPositiveInt(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

/** Compose the effective plugin config from the patch row plus the documented env overrides. */
export function resolveConfig(raw: Record<string, unknown> = {}) {
  const env = process.env
  const merged: Record<string, unknown> = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (env.DSH_DEVICE_LINK_PORT !== undefined) merged.listenPort = env.DSH_DEVICE_LINK_PORT
  if (env.DSH_DEVICE_LINK_BIND !== undefined) merged.bindAddress = env.DSH_DEVICE_LINK_BIND
  if (env.DSH_DEVICE_LINK_ALLOW !== undefined) merged.allowIncoming = env.DSH_DEVICE_LINK_ALLOW
  return {
    allowIncoming: asBoolean(merged.allowIncoming, DEFAULTS.allowIncoming),
    listenPort: asPort(merged.listenPort, DEFAULTS.listenPort),
    bindAddress:
      typeof merged.bindAddress === 'string' && merged.bindAddress.trim()
        ? merged.bindAddress.trim()
        : DEFAULTS.bindAddress,
    deviceName: typeof merged.deviceName === 'string' ? merged.deviceName.trim() : '',
    pairingTtlMs: asPositiveInt(merged.pairingTtlMs, DEFAULTS.pairingTtlMs),
    accessTtlMs: asPositiveInt(merged.accessTtlMs, DEFAULTS.accessTtlMs),
    proxyRequestTimeoutMs: asPositiveInt(merged.proxyRequestTimeoutMs, DEFAULTS.proxyRequestTimeoutMs),
    toolsEnabled: asBoolean(merged.toolsEnabled, DEFAULTS.toolsEnabled),
    maxPairFailures: asPositiveInt(merged.maxPairFailures, DEFAULTS.maxPairFailures),
    failureWindowMs: asPositiveInt(merged.failureWindowMs, DEFAULTS.failureWindowMs),
  }
}

/** Local IPv4 interfaces that are worth advertising, best candidate first. */
export function lanAddresses() {
  const candidates = []
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (!isPrivateIPv4(info.address)) continue
      candidates.push({ name, address: info.address, score: scoreAddress(name, info.address) })
    }
  }
  candidates.sort((left, right) => left.score - right.score)
  return candidates.map(({ name, address }) => ({ name, address }))
}

function scoreAddress(name: string, address: string) {
  let score = 50
  if (address.startsWith('192.168.')) score = 0
  else if (address.startsWith('10.')) score = 5
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score = 10
  // Ranges that are almost never the LAN the other device sits on.
  if (/^192\.168\.56\./.test(address)) score += 60 // VirtualBox host-only default
  // Adapter names that usually mean a virtual switch instead of the physical LAN.
  if (/vmware|virtualbox|vethernet|wsl|hyper-v|mihomo|clash|tailscale|docker|loopback/i.test(name)) score += 100
  if (/wi-?fi|wlan|wireless|802\.11/i.test(name)) score -= 20
  return score
}

/**
 * Resolve the listener address. `auto` picks the best LAN IPv4; an explicit value must be a local
 * IPv4 literal (or `127.0.0.1`, used by tests). `0.0.0.0` is refused on purpose, mirroring the
 * Harness web server: an unspecified bind exposes the proxy on every interface at once.
 */
export function pickBindAddress(requested: string, available = lanAddresses()) {
  const wanted = (requested ?? DEFAULTS.bindAddress).trim()
  if (wanted === 'auto' || wanted === '') {
    const best = available[0]
    if (best) return { address: best.address, all: available, auto: true }
    return { address: '127.0.0.1', all: available, auto: true, degraded: true }
  }
  if (wanted === '0.0.0.0' || wanted === '::') {
    throw new Error('bindAddress must be one concrete local IPv4 literal, not a wildcard address')
  }
  const local = new Set(['127.0.0.1', ...available.map(entry => entry.address)])
  if (!local.has(wanted)) {
    throw new Error(`bindAddress ${wanted} is not one of this machine's IPv4 addresses (${[...local].join(', ')})`)
  }
  return { address: wanted, all: available, auto: false }
}

export function resolveDeviceName(config: { deviceName?: string }, fallbackName?: string) {
  const configured = (config?.deviceName ?? '').trim()
  if (configured) return configured
  return (fallbackName ?? '').trim() || os.hostname() || 'dsh-device'
}
