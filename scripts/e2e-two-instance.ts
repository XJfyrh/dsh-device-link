import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultScope } from '../src/lib/scope.js'
import type { DeviceState } from '../src/lib/api.js'
import type { DeviceTask, SessionContent, OutgoingTask, ExecutionContext } from '../src/lib/types.js'
import { activeTask } from '../src/lib/tasks.js'
import type { ReferenceDescriptor, ReadReceipt } from '../src/lib/references.js'
import type { ResourceResult } from '../src/lib/resources.js'
import { chromium, expect, type Page } from '@playwright/test'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.env.DSH_CLI ?? path.join(process.env.LOCALAPPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const versionProbe = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true })
const hostVersion = versionProbe.stdout?.trim() ?? ''
const versionParts = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(hostVersion)
const minimum = [0, 2, 2, 3]
const actual = versionParts ? [Number(versionParts[1]), Number(versionParts[2]), Number(versionParts[3]), versionParts[4] ? Number(versionParts[4]) : Infinity] : []
const difference = actual.findIndex((value, index) => value !== minimum[index])
if (versionProbe.status !== 0 || !actual.length || difference >= 0 && actual[difference] < minimum[difference]) {
  throw new Error(`DSH ${hostVersion || 'unknown'} 不支持当前插件接口；设置 DSH_CLI 为桌面版同版本（至少 0.2.2-rc.3）的完整入口路径`)
}
console.log(`Harness host ${hostVersion}`)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'device-link-e2e-'))
const children: ChildProcess[] = []
const protocolOnly = process.argv.includes('--protocol-only')
const modelConfigured = !protocolOnly && Boolean(process.env.DEEPSEEK_API_KEY?.trim() || process.env.E2E_MODEL_HOME)
const report: { name: string; passed: boolean; durationMs: number; error?: string }[] = []
let passed = 0
let failed = 0
interface Instance { name: string; base: string; cookie: string; home: string; child: ChildProcess; log(): string }

function stop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}
async function start(name: string, listenPort = 0): Promise<Instance> {
  const home = path.join(root, name)
  const profile = path.join(home, 'profiles', 'test')
  await fs.mkdir(path.join(profile, 'node_modules'), { recursive: true })
  const pluginLink = path.join(profile, 'node_modules', 'dsh-device-link')
  try {
    await fs.symlink(project, pluginLink, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    assert.equal(await fs.realpath(pluginLink), await fs.realpath(project))
  }
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: `device-link-e2e-${name}`, private: true, dependencies: { 'dsh-device-link': `link:${project}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-device-link'] } } }))
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  const fixturePackage = path.join(profile, 'node_modules', 'device-link-test-workspace')
  const workspacePath = path.join(home, 'workspace')
  await fs.mkdir(fixturePackage, { recursive: true })
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.writeFile(path.join(fixturePackage, 'package.json'), JSON.stringify({ name: 'device-link-test-workspace', type: 'module', exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { platform: 'web', immediately: true } } }))
  await fs.writeFile(path.join(fixturePackage, 'index.mjs'), `export const inject = ['workspaceController']
export function apply(ctx, config) {
  void ctx.workspaceController.create({ path: config.path }).catch(error => console.error('Test workspace initialization failed', error))
}
`)
  await fs.writeFile(path.join(fixturePackage, 'client.js'), `
window.__ModuleLoader__.load({
  id: 'device-link-test-workspace',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [index, label] of ['短剧', '代码审查', '笔记'].entries()) {
          function FooterAction({ wide }) {
            return React.createElement('button', {
              'data-test-footer-action': label,
              title: label,
              style: {
                display: 'inline-flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center',
                flex: '0 0 auto', border: 0, background: 'transparent',
                font: 'var(--dsw-font-s-14)', color: 'var(--dsw-alias-label-secondary)',
                padding: '7px 8px', height: 36,
              },
            }, wide ? label : label.slice(0, 1))
          }
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action', id: 'fixture-' + index, order: index,
          }, FooterAction))
        }
      },
    }
  },
})
`)
  const documentsDirectory = JSON.stringify(path.join(home, 'documents'))
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), `- id: device-link
  name: dsh-device-link
  config:
    allowIncoming: true
    listenPort: 0
    bindAddress: 127.0.0.1
    deviceName: harness-${name}
- id: workspace-controller
  config:
    documentsDirectory: ${documentsDirectory}
- insert:
    - id: test-workspace
      name: device-link-test-workspace
      config:
        path: ${JSON.stringify(workspacePath)}
${protocolOnly ? `- id: llm-deepseek
  config:
    apiKeyEnv: DEVICE_LINK_E2E_NO_CREDENTIAL
    baseURL: http://127.0.0.1:9
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
` : ''}
`)
  if (!protocolOnly && process.env.E2E_MODEL_HOME) {
    for (const file of ['.credentials.yaml', 'settings.json']) {
      await fs.copyFile(path.join(process.env.E2E_MODEL_HOME, file), path.join(home, file)).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  const child = spawn(process.execPath, [cli, '--profile', 'test', '--port', '0', '--no-open'], {
    cwd: home, env: { ...process.env, ...(protocolOnly ? { DEEPSEEK_API_KEY: '', DEVICE_LINK_E2E_NO_CREDENTIAL: '' } : {}), DSH_HOME: home, DSH_DEVICE_LINK_PORT: String(listenPort), DSH_DEVICE_LINK_BIND: '127.0.0.1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
  const instance = { name, base: new URL(url).origin, cookie, home, child, log: () => output.replace(/token=[^\s]+/g, 'token=[redacted]') }
  const readyDeadline = Date.now() + 15_000
  while (Date.now() < readyDeadline) {
    const state = await api<DeviceState>(instance, 'state')
    if (state.host.workspaces.some(workspace => workspace.path === workspacePath)) return instance
    await delay(100)
  }
  throw new Error(`test workspace did not initialize\n${instance.log()}`)
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
async function runTask(instance: Instance, input: { deviceId: string; workspacePath: string; task: string }, timeoutMs: number): Promise<DeviceTask> {
  const id = crypto.randomUUID()
  let current = (await api<{ task: OutgoingTask }>(instance, 'task-start', { ...input, id })).task
  const deadline = Date.now() + timeoutMs
  while (!current.remote || activeTask(current.remote)) {
    assert.notEqual(current.submission, 'failed', current.connectionError)
    assert.ok(Date.now() < deadline, `task ${id} did not finish: ${current.remote?.status ?? current.submission}`)
    await delay(300)
    current = (await api<{ task: OutgoingTask }>(instance, 'task-refresh', { id })).task
  }
  return current.remote
}
async function step(name: string, operation: () => Promise<void>): Promise<void> {
  const started = Date.now()
  try {
    await operation()
    passed++
    report.push({ name, passed: true, durationMs: Date.now() - started })
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    report.push({ name, passed: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
    console.error(`FAIL ${name}`, error)
  }
}
async function capture(page: Page, name: string): Promise<void> {
  const directory = path.join(project, '.e2e')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${name}.txt`), await page.locator('body').ariaSnapshot())
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true })
}
async function assertFooterLayout(page: Page): Promise<void> {
  await expect(page.locator('[data-test-footer-action]')).toHaveCount(3)
  await expect.poll(() => page.locator('.dl-footer').evaluate(element => {
    const container = element.closest('[data-slot="sidebar.footer.action"]')!.parentElement!
    const bounds = container.getBoundingClientRect()
    const entries = [...container.querySelectorAll<HTMLElement>('[data-test-footer-action], .dl-footer')].map(item => item.getBoundingClientRect())
    return bounds.left >= 0 && entries.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1)
      && entries.every((rect, index) => index === 0 || rect.top >= entries[index - 1].bottom)
      && entries.every((rect, index) => entries.slice(index + 1).every(other => rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top))
  })).toBe(true)
}
async function assertNativeTypography(page: Page): Promise<void> {
  const fonts = await page.evaluate(() => {
    const native = getComputedStyle(document.querySelector('nav button')!)
    const panel = getComputedStyle(document.querySelector('.dl-popover')!)
    const heading = getComputedStyle(document.querySelector('.dl-popover h2')!)
    return { native: { family: native.fontFamily, size: native.fontSize, line: native.lineHeight },
      panel: { family: panel.fontFamily, size: panel.fontSize, line: panel.lineHeight }, weight: heading.fontWeight }
  })
  assert.deepEqual(fonts.panel, fonts.native)
  assert.equal(fonts.weight, '500')
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
  let a = await start('a')
  const b = await start('b')
  const sa = await api<DeviceState>(a, 'state')
  const sb = await api<DeviceState>(b, 'state')
  assert.ok(sa.listen && sb.listen)
  const listenA = sa.listen
  const listenB = sb.listen
  const lanA = `http://${listenA.host}:${listenA.port}`
  let peerId = ''
  let cookie = ''
  let fileSessionId = ''
  let failureSessionId = ''
  let decisionSessionId = ''
  const executionWorkspace = path.join(root, 'remote-workspace')
  const marker = `DEVICE_FILE_${crypto.randomUUID()}`
  await fs.mkdir(executionWorkspace)
  await fs.writeFile(path.join(executionWorkspace, 'input.txt'), marker)
  await fs.writeFile(path.join(executionWorkspace, 'invoice.test.mjs'), "import assert from 'node:assert/strict'\nconst response = { status: 401 }\nassert.equal(response.status, 200, 'DEVICE_TEST_FAILURE')\n")
  await fs.writeFile(path.join(a.home, 'workspace', 'invoice.ts'), 'export function createInvoice(amount: number) {\n  // API_REFERENCE_OK: returns amount including 10% tax\n  return { total: amount * 1.1 };\n}\n')
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
    await expect.poll(async () => (await api<DeviceState>(b, 'state')).peers[0].online, { timeout: 10_000 }).toBe(true)
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
  await step('workspace reference reads exact versions without adding preview to agent receipts', async () => {
    const { descriptor } = await api<{ descriptor: ReferenceDescriptor }>(b, 'reference-prepare', { deviceId: peerId, workspacePath: path.join(a.home, 'workspace') })
    const searched = await api<{ result: ResourceResult }>(b, 'reference-preview', { referenceId: descriptor.id, action: 'search', query: 'createInvoice' })
    assert.equal(searched.result.items[0].path, 'invoice.ts')
    const item = searched.result.items[0]
    const read = await api<{ result: ResourceResult }>(b, 'reference-preview', { referenceId: descriptor.id, action: 'read', path: item.path, revision: item.revision, startLine: item.startLine })
    assert.match(read.result.items[0].text!, /API_REFERENCE_OK/)
    assert.equal((await api<{ receipts: ReadReceipt[] }>(b, 'reference-detail', { referenceId: descriptor.id, localSessionId: 'unrelated' })).receipts.length, 0)
  })
  await step('persistent task admission exposes a durable remote session and outcome', async () => {
    const result = await runTask(b, { deviceId: peerId, workspacePath: project, task: '本次项目决策：当前只有单实例，先用进程内缓存，不引入 Redis；出现多实例共享需求时再调整。请不要调用工具，确认收到并附上 DEVICE_LINK_OK。' }, 30_000)
    decisionSessionId = result.sessionId
    assert.ok(result.sessionId.startsWith('delegate-'))
    if (modelConfigured) {
      assert.equal(result.status, 'completed', result.error)
      assert.match(result.text, /DEVICE_LINK_OK/)
    } else {
      assert.equal(result.status, 'error')
      assert.ok(result.error, 'unconfigured model must report its failure')
      if (protocolOnly) assert.match(result.error, /DEVICE_LINK_E2E_NO_CREDENTIAL/)
      console.log(`  model outcome ${result.status}${result.error ? ` (${result.error})` : ''}`)
    }
    const remote = await api<DeviceState>(a, 'state')
    assert.ok(remote.host.sessions.some(session => session.id === result.sessionId))
  })
  if (modelConfigured) {
    await step('scoped remote model reads a fixture and writes a file in its execution workspace', async () => {
      await api(a, 'scope', { deviceId: sb.identity.deviceId, scope: { ...defaultScope('different-account'), workspaces: [executionWorkspace], allowDelegate: true, sessionSync: 'content' } })
      const result = await runTask(b, {
        deviceId: peerId,
        workspacePath: executionWorkspace,
        task: '使用文件工具读取当前工作区的 input.txt，将其文本原样写入 result.txt。最后回复读取到的文本。',
      }, 120_000)
      assert.equal(result.status, 'completed', result.error)
      assert.equal((await fs.readFile(path.join(executionWorkspace, 'result.txt'), 'utf8')).trim(), marker)
      assert.ok(result.text.includes(marker), 'remote reply must include text read from the fixture')
      fileSessionId = result.sessionId
    })
    await step('remote grants reject a task outside the permitted workspace', async () => {
      const { task } = await api<{ task: OutgoingTask }>(b, 'task-start', { id: crypto.randomUUID(), deviceId: peerId, workspacePath: project, task: 'Reply blocked' })
      assert.equal(task.submission, 'failed')
      assert.match(task.connectionError ?? '', /workspace/)
      assert.equal(task.remote, undefined)
    })
    await step('remote transcript is synced and available through the local session endpoint', async () => {
      assert.ok(fileSessionId)
      await api(b, 'sync', { deviceId: peerId })
      const cached = await api<{ session: SessionContent; cachedAt: string }>(b, 'session', { deviceId: peerId, sessionId: fileSessionId })
      assert.ok(cached.session.messages.some(message => message.role === 'assistant' && message.text.includes(marker)))
      assert.ok(cached.session.messages.every(message => !message.text.includes('Current runtime context.') && !message.text.includes('<system-reminder>')))
      assert.ok(Date.parse(cached.cachedAt))
    })
    await api(a, 'scope', { deviceId: sb.identity.deviceId, scope: { ...defaultScope('same-account'), sessionTools: true } })
    await api(b, 'sync', { deviceId: peerId })
    await step('native event query reads an actual failed terminal result', async () => {
      const task = await runTask(b, { deviceId: peerId, workspacePath: executionWorkspace,
        task: '运行 node invoice.test.mjs，不要修改文件。告诉我测试结果。' }, 120_000)
      assert.equal(task.status, 'completed', task.error)
      failureSessionId = task.sessionId
      await api(b, 'sync', { deviceId: peerId })
      const { descriptor } = await api<{ descriptor: ReferenceDescriptor }>(b, 'reference-prepare', { deviceId: peerId, sessionId: task.sessionId })
      const searched = await api<{ result: ResourceResult }>(b, 'reference-preview', { referenceId: descriptor.id, action: 'search', query: 'DEVICE_TEST_FAILURE' })
      const result = searched.result.items.find(item => item.type === 'tool/result')
      assert.ok(result, 'native query must expose the authorized tool result')
      const read = await api<{ result: ResourceResult }>(b, 'reference-preview', { referenceId: descriptor.id, action: 'read', seq: result.seq, revision: result.revision })
      assert.match(read.result.items[0].text!, /401/)
    })
  }
  if (modelConfigured) await step('persistent tasks survive polling retries and continue the same remote session', async () => {
    const id = crypto.randomUUID()
    const input = { id, deviceId: peerId, workspacePath: executionWorkspace, task: '只回复 PERSISTENT_TASK_OK。' }
    const first = await api<{ task: OutgoingTask }>(b, 'task-start', input)
    const second = await api<{ task: OutgoingTask }>(b, 'task-start', input)
    assert.equal(first.task.id, second.task.id)
    let finished: OutgoingTask
    await expect.poll(async () => {
      finished = (await api<{ task: OutgoingTask }>(b, 'task-refresh', { id })).task
      return finished.remote?.status
    }, { timeout: 120_000, intervals: [800] }).toBe('completed')
    assert.ok(finished!.remote!.text.includes('PERSISTENT_TASK_OK'))
    const nextId = crypto.randomUUID()
    await api(b, 'task-start', { ...input, id: nextId, sessionId: finished!.remote!.sessionId, task: '只回复 CONTINUED_TASK_OK。' })
    let continued: OutgoingTask
    await expect.poll(async () => {
      continued = (await api<{ task: OutgoingTask }>(b, 'task-refresh', { id: nextId })).task
      return continued.remote?.status
    }, { timeout: 120_000, intervals: [800] }).toBe('completed')
    assert.equal(continued!.remote!.sessionId, finished!.remote!.sessionId)
    assert.ok(continued!.remote!.text.includes('CONTINUED_TASK_OK'))
    const stoppedId = crypto.randomUUID()
    await api(b, 'task-start', { ...input, id: stoppedId, task: '请仔细推理并写出一千字的排序算法比较。' })
    const stopped = await api<{ task: OutgoingTask }>(b, 'task-cancel', { id: stoppedId })
    assert.equal(stopped.task.remote?.status, 'stopped')
    const saved = await api<{ tasks: OutgoingTask[] }>(b, 'tasks')
    assert.equal(saved.tasks.find(task => task.id === id)?.remote?.status, 'completed')
  })
  if (process.env.E2E_BROWSER === '1') {
    await step('device panel, favorites, reference chips, task cards, settings and offline preview', async () => {
      const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH })
      let page: Page | undefined
      const errors: string[] = []
      try {
        async function open(instance: Instance) {
          const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
          const [name, ...parts] = instance.cookie.split('=')
          await context.addCookies([{ name, value: parts.join('='), url: instance.base }])
          const result = await context.newPage()
          result.setDefaultTimeout(15_000)
          result.on('pageerror', error => errors.push(error.message))
          await result.goto(instance.base)
          await result.getByRole('dialog', { name: '预览版说明', exact: true }).getByRole('button', { name: '继续', exact: true }).click()
          if (!modelConfigured) await result.getByRole('dialog', { name: '开始使用', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
          await result.getByRole('button', { name: '设备', exact: true }).waitFor()
          return result
        }
        page = await open(b)
        await assertFooterLayout(page)
        await page.getByRole('button', { name: '设备', exact: true }).click()
        await assertNativeTypography(page)
        await capture(page, 'device-panel')
        await page.getByRole('button', { name: '＋ 连接设备', exact: true }).click()
        await page.getByLabel('设备地址', { exact: true }).fill(lanA)
        await page.getByRole('button', { name: '诊断连接', exact: true }).click()
        await expect(page.getByText('连接正常，请在对端生成配对码', { exact: false })).toBeVisible()
        await page.getByRole('button', { name: '允许连接本机', exact: true }).click()
        await page.getByRole('combobox', { name: '首次配对的账号关系', exact: true }).click()
        await page.getByRole('option', { name: '我已确认使用同一账号', exact: true }).click()
        await page.getByRole('button', { name: '生成配对码', exact: true }).click()
        await expect(page.locator('.code')).toHaveText(/^\d{8}$/)
        const pairingCode = (await page.locator('.code').innerText()).trim()
        const aPage = await open(a)
        await aPage.getByRole('button', { name: '设备', exact: true }).click()
        await expect(aPage.locator('.dl-popover .empty')).toContainText('连接另一台设备，访问它的工作区')
        await expect(aPage.locator('.dl-popover').getByRole('button', { name: /连接设备/ })).toHaveCount(1)
        await aPage.getByRole('button', { name: '＋ 连接设备', exact: true }).click()
        await aPage.getByLabel('设备地址', { exact: true }).fill(`http://${listenB.host}:${listenB.port}`)
        await aPage.getByLabel('配对码', { exact: true }).fill(pairingCode)
        await aPage.getByRole('button', { name: '连接设备', exact: true }).click()
        await aPage.getByRole('button', { name: /harness-b.*在线/ }).click()
        await aPage.getByRole('button', { name: '管理设备', exact: true }).click()
        const [popup] = await Promise.all([
          aPage.waitForEvent('popup'),
          aPage.getByRole('button', { name: '打开设备界面', exact: true }).click(),
        ])
        await popup.getByRole('button', { name: '账号菜单', exact: true }).waitFor()
        assert.equal(new URL(popup.url()).port, String(listenB.port))
        await capture(popup, 'proxied-harness')
        await popup.close()
        await page.getByRole('button', { name: '关闭设备面板', exact: true }).click()
        await page.getByRole('button', { name: '设备', exact: true }).click()
        await page.getByRole('button', { name: /harness-a.*在线/ }).click()
        await page.getByRole('button', { name: '收藏 workspace', exact: true }).click()
        await capture(page, 'device-detail')
        await page.getByRole('button', { name: '设备列表', exact: true }).click()
        await page.getByRole('tab', { name: '工作区', exact: true }).click()
        const favoriteWorkspace = page.getByRole('region', { name: '收藏的工作区', exact: true }).getByRole('button', { name: 'workspace 在线 harness-a', exact: true })
        await expect(favoriteWorkspace).toBeVisible()
        await favoriteWorkspace.click()
        await page.getByRole('button', { name: '添加到当前任务', exact: true }).click()
        const composer = page.getByRole('textbox', { name: /\/ 调用指令, @ 文件或对话$/ })
        await expect(composer).toContainText('workspace（harness-a）')
        await page.getByRole('button', { name: '浏览资料', exact: true }).click()
        await expect(page.locator('.dl-reference-panel').getByRole('button', { name: '返回工作区', exact: true })).toBeVisible()
        await page.getByRole('button', { name: '返回工作区', exact: true }).click()
        await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: '浏览资料', exact: true })).toBeVisible()
        await expect(composer).toContainText('workspace（harness-a）')
        await capture(page, 'workspace-preview-reference')
        await page.reload()
        if (!modelConfigured) await page.getByRole('dialog', { name: '开始使用', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
        await page.getByRole('button', { name: '设备', exact: true }).click()
        await page.getByRole('tab', { name: '工作区', exact: true }).click()
        await expect(favoriteWorkspace).toBeVisible()
        await page.getByRole('button', { name: '关闭设备面板', exact: true }).click()
        await composer.fill('@harness-a')
        await page.getByRole('option').filter({ hasText: path.join(a.home, 'workspace') }).first().click()
        await expect(composer).toContainText('workspace（harness-a）')
        if (modelConfigured) {
          await composer.press('End')
          await composer.pressSequentially(' 请分析 createInvoice 接口，说明输入、返回值，以及金额为 100 时的结果。')
          await page.getByRole('button', { name: '发送消息', exact: true }).click()
          await expect.poll(async () => (await api<DeviceState>(b, 'state')).host.agents.some(agent => agent.status === 'running'), { timeout: 120_000 }).toBe(false)
          await expect(page.locator('.dl-resource-tool').filter({ hasText: '读取 invoice.ts' }).first()).toBeAttached({ timeout: 120_000 })
          await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 120_000 })
          await expect(page.getByText(/110/).last()).toBeVisible()
          await page.locator('.dl-reference').last().click()
          await page.locator('.dl-reference-panel').getByRole('button', { name: 'invoice.ts', exact: true }).click()
          await expect(page.locator('.dl-source-text')).toContainText('createInvoice')
          await capture(page, 'reference-agent-receipts')
          console.log('PASS natural prompt: agent reads interface code without user naming tools')
          const closeResource = page.getByRole('button', { name: '收起右侧边栏', exact: true })
          if (await closeResource.isVisible()) await closeResource.click()
          await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
          await expect(page.getByRole('button', { name: '标准模式', exact: true })).toBeVisible()
          const failureTitle = (await api<DeviceState>(b, 'state')).peers.find(peer => peer.deviceId === peerId)!.status!.host.sessions.find(session => session.id === failureSessionId)!.title
          await composer.fill('@harness-a')
          await page.getByRole('option').filter({ hasText: failureTitle }).click()
          await composer.press('End')
          await composer.pressSequentially(' 这次测试为什么失败？')
          await page.getByRole('button', { name: '发送消息', exact: true }).click()
          await expect(page.locator('.dl-resource-tool').first()).toBeAttached({ timeout: 120_000 })
          await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 120_000 })
          await expect.poll(async () => (await api<DeviceState>(b, 'state')).host.agents.some(agent => agent.status === 'running'), { timeout: 120_000 }).toBe(false)
          await capture(page, 'reference-failed-task')
          await expect(page.getByText(/401/).last()).toBeVisible()
          console.log('PASS natural prompt: agent retrieves failure evidence without user naming tools')
          await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
          await expect(page.getByRole('button', { name: '标准模式', exact: true })).toBeVisible()
          await composer.fill('@harness-a')
          await page.getByRole('option').filter({ hasText: path.join(a.home, 'workspace') }).first().click()
          await composer.press('End')
          await composer.pressSequentially(' 请在引用的设备工作区执行一条任务，让那台设备回复 WORKSPACE_MENTION_OK。')
          await page.getByRole('button', { name: '发送消息', exact: true }).click()
          const card = page.locator('.dl-task').filter({ hasText: 'WORKSPACE_MENTION_OK' }).first()
          await expect(card.locator('.task-state')).toHaveText('已完成', { timeout: 120_000 })
          await expect(card.locator('.dl-excerpt')).toContainText('WORKSPACE_MENTION_OK')
          await expect.poll(async () => (await api<DeviceState>(b, 'state')).host.agents.some(agent => agent.status === 'running'), { timeout: 120_000 }).toBe(false)
          await expect(page.locator('.dl').getByText('value is not lossless JSON', { exact: false })).toHaveCount(0)
          await capture(page, 'workspace-mention-result')
          await composer.fill('返回本地后保留的草稿')
          if (!await card.locator('.dl-task-link').isVisible()) await page.getByRole('button', { name: /^已完成，用时/ }).last().click()
          if (!await card.locator('.dl-task-link').isVisible()) await page.getByRole('button', { name: '已调用工具', exact: true }).last().click()
          await card.locator('.dl-task-link').click()
          await expect(page.locator('.dl-transcript')).toContainText('WORKSPACE_MENTION_OK')
          await page.getByRole('button', { name: '返回本地会话', exact: true }).click()
          await expect(composer).toContainText('返回本地后保留的草稿')
          await composer.fill('')
          await page.getByRole('button', { name: '设备', exact: true }).click()
          await page.getByRole('tab', { name: '工作区', exact: true }).click()
          await favoriteWorkspace.click()
          await page.getByRole('button', { name: '新建任务', exact: true }).click()
          const beforeModel = (await api<DeviceState>(a, 'state')).host.model
          const execution = await api<ExecutionContext>(b, 'execution', {deviceId: peerId, workspacePath: executionWorkspace})
          const modelPicker = page.getByRole('button', {name: /^模型与思考强度/})
          await expect(modelPicker).toBeVisible()
          const modelChoices = execution.catalog.groups.flatMap(group => group.models.map(model => ({provider:group.id,model:model.id,name:model.name})))
          const chosen = modelChoices.find(model => model.model !== execution.selected.model) ?? modelChoices.find(model => model.model === execution.selected.model)!
          await modelPicker.click()
          await page.getByRole('menuitem', {name: /^模型/}).click()
          await page.getByRole('menuitemradio', {name: chosen.name, exact: true}).click()
          await page.getByLabel('设备任务内容').fill('只回复 FORM_DELEGATE_OK。')
          await page.reload()
          await page.getByRole('button', { name: '设备任务', exact: true }).click()
          await expect(page.getByLabel('设备任务内容')).toHaveValue('只回复 FORM_DELEGATE_OK。')
          await expect(modelPicker).toContainText(chosen.name)
          await page.route('**/device-link/api/task-start', async route => {
            await route.fetch()
            await route.abort('failed')
          }, { times: 1 })
          await page.getByRole('button', { name: '开始任务', exact: true }).click()
          const direct = page.locator('.dl-turn').filter({ hasText: '只回复 FORM_DELEGATE_OK。' }).first()
          await expect(direct.locator('.dl-turn-status')).toContainText('已完成', { timeout: 120_000 })
          await expect(direct.locator('.assistant')).toContainText('FORM_DELEGATE_OK')
          const firstTask = (await api<{tasks:OutgoingTask[]}>(b,'tasks')).tasks.find(task=>task.prompt==='只回复 FORM_DELEGATE_OK。')!
          assert.equal((await api<{tasks:OutgoingTask[]}>(b,'tasks')).tasks.filter(task=>task.prompt==='只回复 FORM_DELEGATE_OK。').length,1)
          assert.equal(firstTask.remote?.model,chosen.model)
          assert.deepEqual((await api<DeviceState>(a,'state')).host.model,beforeModel)
          await page.getByLabel('设备任务内容').fill('只回复 UI_CONTINUE_OK。')
          await page.getByRole('button', { name: '发送', exact: true }).click()
          const continued = page.locator('.dl-turn').filter({ hasText: '只回复 UI_CONTINUE_OK。' }).first()
          await expect(continued.locator('.dl-turn-status')).toContainText('已完成', { timeout: 120_000 })
          const secondTask = (await api<{tasks:OutgoingTask[]}>(b,'tasks')).tasks.find(task=>task.prompt==='只回复 UI_CONTINUE_OK。')!
          assert.equal(secondTask.remote?.sessionId,firstTask.remote?.sessionId)
          await page.getByLabel('设备任务内容').fill('尚未发送的下一条草稿')
          await page.reload()
          await page.getByRole('button', { name: '设备任务', exact: true }).click()
          await expect(page.getByLabel('设备任务内容')).toHaveValue('尚未发送的下一条草稿')
          await expect(continued.locator('.assistant')).toContainText('UI_CONTINUE_OK')
          await expect(page.locator('.dl-user-bubble').filter({hasText:'只回复 FORM_DELEGATE_OK。'})).toHaveCount(1)
          await expect(page.locator('.dl-user-bubble').filter({hasText:'只回复 UI_CONTINUE_OK。'})).toHaveCount(1)
          await capture(page, 'persistent-task-cards')
          await page.setViewportSize({width:900,height:764})
          await expect(page.getByLabel('设备任务内容')).toBeInViewport()
          await expect(page.getByRole('button', {name:'发送',exact:true})).toBeInViewport()
          await capture(page, 'conversation-narrow')
          await page.setViewportSize({width:1440,height:960})
          await page.getByRole('button', { name: '返回工作区', exact: true }).click()
          await expect.poll(async () => (await api<DeviceState>(b, 'state')).host.agents.some(agent => agent.status === 'running'), { timeout: 120_000 }).toBe(false)
          await api(b, 'sync', { deviceId: peerId })
          stop(a.child)
          await api(b, 'sync', { deviceId: peerId })
          await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
          await expect(page.getByRole('button', { name: '标准模式', exact: true })).toBeVisible()
          const cachedTitle=(await api<DeviceState>(b,'state')).peers.find(peer=>peer.deviceId===peerId)!.status!.host.sessions.find(session=>session.id===decisionSessionId)!.title
          await composer.fill('@harness-a')
          await page.getByRole('option').filter({ hasText: cachedTitle }).click()
          await composer.press('End')
          await composer.pressSequentially(' 我们当时为什么没用 Redis？')
          await page.getByRole('button', { name: '发送消息', exact: true }).click()
          await expect(page.locator('.dl-resource-tool').first()).toBeAttached({ timeout: 120_000 })
          await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 120_000 })
          await expect(page.getByText(/单实例/).last()).toBeVisible()
          await expect.poll(async () => (await api<DeviceState>(b, 'state')).host.agents.some(agent => agent.status === 'running'), { timeout: 120_000 }).toBe(false)
          await expect(page.locator('.dl-reference')).toHaveCount(1)
          await capture(page, 'offline-session-reference')
          await page.locator('.dl-reference').click()
          await expect(page.locator('.dl-reference-panel')).toContainText('设备离线，正在浏览缓存')
          await expect(page.locator('.dl-reference-panel')).toContainText('Redis')
          await capture(page, 'offline-reference-receipts')
          console.log('PASS natural prompt: agent reviews cached decision while source device is offline')
          const closeReference = page.getByRole('button', { name: '收起右侧边栏', exact: true })
          if (await closeReference.isVisible()) await closeReference.click()
          a = await start('a', listenA.port)
          await api(b, 'sync', { deviceId: peerId })
        }
        await page.getByRole('button', { name: '设备', exact: true }).click()
        await page.getByRole('button', { name: '连接设置', exact: true }).click()
        const settings = page.getByRole('dialog', { name: '设备连接设置', exact: true })
        const toggle = settings.getByRole('checkbox', { name: '允许局域网设备连接', exact: true })
        await toggle.click()
        await expect.poll(async () => (await api<DeviceState>(b, 'state')).allowIncoming).toBe(false)
        await expect(toggle).not.toBeChecked()
        await toggle.click()
        await expect.poll(async () => (await api<DeviceState>(b, 'state')).allowIncoming).toBe(true)
        await expect(toggle).toBeChecked()
        const trusted = settings.locator('article').filter({ has: page.getByRole('heading', { name: 'harness-a', exact: true }) })
        await trusted.getByText('修改授权', { exact: true }).click()
        await trusted.getByRole('combobox', { name: '会话同步', exact: true }).click()
        await page.getByRole('option', { name: '会话目录', exact: true }).click()
        await trusted.getByRole('button', { name: '保存范围', exact: true }).click()
        await expect.poll(async () => (await api<DeviceState>(b, 'state')).trusted[0]?.scope.sessionSync).toBe('metadata')
        await trusted.getByRole('button', { name: '撤销授权', exact: true }).click()
        await expect(trusted).toHaveCount(0)
        await capture(page, 'device-settings')
        await settings.getByRole('button', { name: '关闭连接设置', exact: true }).click()
        await page.keyboard.press('Control+Alt+Comma')
        const nativeSettings = page.locator('[data-shortcut-modal="settings"]')
        const deviceNav = nativeSettings.locator('nav').getByRole('button', { name: '设备连接', exact: true })
        await deviceNav.click()
        await expect(deviceNav.locator('svg')).toHaveCount(1)
        await expect(deviceNav.locator('.dl-device-icon')).toHaveCount(1)
        await expect(nativeSettings.getByLabel('本机名称', { exact: true })).toHaveValue('harness-b')
        await capture(page, 'native-device-settings')
        await page.keyboard.press('Escape')
        const closePreview = page.getByRole('button', { name: '收起右侧边栏', exact: true })
        if (await closePreview.isVisible()) await closePreview.click()
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
        await expect(page.locator('.device-trigger')).toHaveClass(/rail/)
        await expect.poll(async () => (await page!.locator('.dl-footer').boundingBox())?.width ?? Infinity).toBeLessThan(50)
        await assertFooterLayout(page)
        await capture(page, 'device-footer-collapsed')
        await page.setViewportSize({ width: 760, height: 840 })
        await page.keyboard.press('Control+Alt+B')
        await expect(page.locator('.device-trigger')).toBeVisible()
        await assertFooterLayout(page)
        await page.getByRole('button', { name: '设备', exact: true }).click()
        await page.getByRole('button', { name: '关闭设备面板', exact: true }).click({ trial: true })
        await capture(page, 'device-panel-narrow')
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: '设备面板', exact: true })).toHaveCount(0)
        assert.deepEqual(errors, [])
      } catch (error) {
        if (page) await capture(page, 'browser-failure')
        throw error
      } finally {
        if (a.child.exitCode !== null) a = await start('a', listenA.port)
        await browser.close()
      }
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
await fs.mkdir(path.join(project, '.e2e'), { recursive: true })
await fs.writeFile(path.join(project, '.e2e', 'acceptance.json'), JSON.stringify({ completedAt: new Date().toISOString(), hostVersion, modelConfigured, passed, failed, tests: report }, null, 2))
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
