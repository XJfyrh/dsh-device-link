import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultScope } from '../src/lib/scope.js'
import type { DeviceState } from '../src/lib/api.js'
import type { DelegateResult } from '../src/lib/types.js'
import { chromium } from '@playwright/test'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.env.DSH_CLI ?? path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'device-link-e2e-'))
const children: ChildProcess[] = []
let passed = 0
let failed = 0
interface Instance { name: string; base: string; cookie: string; home: string; child: ChildProcess; log(): string }

function stop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}
async function start(name: string): Promise<Instance> {
  const home = path.join(root, name)
  const profile = path.join(home, 'profiles', 'test')
  await fs.mkdir(path.join(profile, 'node_modules'), { recursive: true })
  await fs.symlink(project, path.join(profile, 'node_modules', 'dsh-device-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: `device-link-e2e-${name}`, private: true, dependencies: { 'dsh-device-link': `link:${project}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-device-link'] } } }))
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), `- id: device-link\n  name: dsh-device-link\n  config:\n    allowIncoming: true\n    listenPort: 0\n    bindAddress: 127.0.0.1\n    deviceName: harness-${name}\n`)
  // Optional model credentials and settings are supplied by an explicit isolated template home.
  if (process.env.E2E_MODEL_HOME) {
    for (const file of ['.credentials.yaml', 'settings.json']) {
      await fs.copyFile(path.join(process.env.E2E_MODEL_HOME, file), path.join(home, file)).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  const child = spawn(process.execPath, [cli, '--profile', 'test', '--port', '0', '--no-open'], {
    cwd: project, env: { ...process.env, DSH_HOME: home, DSH_DEVICE_LINK_PORT: '0', DSH_DEVICE_LINK_BIND: '127.0.0.1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  const deadline = Date.now() + 60_000
  let url: string | undefined
  while (Date.now() < deadline && child.exitCode === null) {
    url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(output)?.[0]
    if (url) break
    await delay(250)
  }
  if (!url) throw new Error(`${name} startup failed\n${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`)
  const response = await fetch(url, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
  assert.ok(cookie, 'owner cookie exchange')
  return { name, base: new URL(url).origin, cookie, home, child, log: () => output.replace(/token=[^\s]+/g, 'token=[redacted]') }
}
async function api<T = Record<string, unknown>>(instance: Instance, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${instance.base}/device-link/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: instance.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(650_000) })
  const text = await response.text()
  if (!text) throw new Error(`empty HTTP ${response.status} at ${route}\n${instance.log().slice(-6000)}`)
  const payload = JSON.parse(text) as T & { error?: string }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${payload.error}`)
  return payload
}
async function step(name: string, operation: () => Promise<void>): Promise<void> {
  try { await operation(); passed++; console.log(`PASS ${name}`) } catch (error) { failed++; console.error(`FAIL ${name}`, error) }
}
function websocket(url: string, cookie: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/api/remote.mux`, { headers: { cookie, origin: url, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
    req.once('upgrade', (response, socket) => { socket.destroy(); assert.equal(response.statusCode, 101); resolve() })
    req.once('response', response => { response.resume(); reject(new Error(`upgrade HTTP ${response.statusCode}`)) })
    req.once('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('upgrade timed out')))
    req.end()
  })
}

try {
  const a = await start('a')
  const b = await start('b')
  const sa = await api<DeviceState>(a, 'state')
  const sb = await api<DeviceState>(b, 'state')
  assert.ok(sa.listen && sb.listen)
  const lanA = `http://${sa.listen.host}:${sa.listen.port}`
  let peerId = ''
  let cookie = ''
  await step('two isolated Harness hosts expose typed device state', async () => {
    assert.equal(sa.identity.name, 'harness-a')
    assert.equal(sb.identity.name, 'harness-b')
    assert.equal(sa.pairing, null)
  })
  await step('owner API rejects anonymous requests', async () => {
    assert.equal((await fetch(`${a.base}/device-link/api/state`)).status, 401)
  })
  await step('diagnose and pair with an owner-selected same-account grant', async () => {
    const diagnostic = await api<{ diagnostic: { ok: boolean } }>(b, 'diagnose', { address: lanA })
    assert.equal(diagnostic.diagnostic.ok, true)
    const grant = await api<{ code: string }>(a, 'allow', { relationship: 'same-account', scope: defaultScope('same-account') })
    const paired = await api<{ peer: { deviceId: string } }>(b, 'pair', { address: lanA, code: grant.code })
    peerId = paired.peer.deviceId
    assert.ok((await api<DeviceState>(b, 'state')).peers[0].online)
    await assert.rejects(() => api(b, 'pair', { address: lanA, code: grant.code }))
  })
  await step('remote GUI loads through a one-time URL and WebSocket proxy', async () => {
    const access = await api<{ url: string }>(b, 'open', { deviceId: peerId })
    const enter = await fetch(access.url, { redirect: 'manual' })
    assert.equal(enter.status, 302)
    cookie = enter.headers.getSetCookie()[0].split(';')[0]
    const page = await fetch(lanA, { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /__DSH_BOOT__/)
    assert.equal(page.headers.getSetCookie().length, 0)
    await websocket(lanA, cookie)
    assert.equal((await fetch(access.url, { redirect: 'manual' })).status, 401)
  })
  await step('UI creation path admits delegation and exposes the remote session', async () => {
    const result = await api<DelegateResult>(b, 'delegate', { deviceId: peerId, workspacePath: project, task: 'Reply with DEVICE_LINK_OK. Do not use tools.', timeoutMs: 30_000 })
    assert.ok(result.sessionId.startsWith('delegate-'))
    if (process.env.DEEPSEEK_API_KEY?.trim() || process.env.E2E_MODEL_HOME) {
      assert.equal(result.status, 'completed', result.error)
      assert.match(result.text, /DEVICE_LINK_OK/)
    } else {
      assert.ok(['completed', 'error', 'timeout'].includes(result.status))
      console.log(`  model outcome ${result.status}${result.error ? ` (${result.error})` : ''}`)
    }
    const remote = await api<DeviceState>(a, 'state')
    assert.ok(remote.host.sessions.some(session => session.id === result.sessionId))
  })
  if (process.env.E2E_BROWSER === '1') {
    await step('browser loads the Harness shell without JavaScript exceptions', async () => {
      const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH })
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        const [name, ...parts] = b.cookie.split('=')
        await context.addCookies([{ name, value: parts.join('='), url: b.base }])
        const page = await context.newPage()
        page.setDefaultTimeout(10_000)
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(b.base)
        await page.getByText('预览版说明', { exact: true }).waitFor()
        await fs.mkdir(path.join(project, '.e2e'), { recursive: true })
        await page.screenshot({ path: path.join(project, '.e2e', 'harness-shell.png'), fullPage: true })
        assert.deepEqual(errors, [])
      } finally { await browser.close() }
    })
  }
  await step('restricted grants close full UI access and filter session sync', async () => {
    await api(a, 'scope', { deviceId: sb.identity.deviceId, scope: { ...defaultScope('different-account'), workspaces: [project], allowDelegate: true, sessionSync: 'metadata' } })
    assert.equal((await fetch(lanA, { headers: { cookie } })).status, 403)
    await assert.rejects(() => api(b, 'open', { deviceId: peerId }), /403/)
    await api(b, 'sync', { deviceId: peerId })
    assert.deepEqual((await api<DeviceState>(b, 'state')).peers[0].cachedSessionIds, [])
  })
  await step('incoming toggle gates existing tokens', async () => {
    await api(a, 'toggle', { allowIncoming: false })
    assert.equal((await fetch(lanA, { headers: { cookie } })).status, 403)
    await api(a, 'toggle', { allowIncoming: true })
  })
  await step('revoke clears the grant and connector cache', async () => {
    await api(a, 'revoke', { deviceId: sb.identity.deviceId, side: 'trusted' })
    assert.equal((await fetch(lanA, { headers: { cookie } })).status, 401)
    await api(b, 'sync', { deviceId: peerId })
    assert.equal((await api<DeviceState>(b, 'state')).peers[0].cachedAt, null)
  })
} finally {
  for (const child of children) stop(child)
  // Only this run's freshly minted temporary directory can be removed.
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('device-link-e2e-')) throw new Error('invalid cleanup root')
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
