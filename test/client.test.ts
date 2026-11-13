import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { buildSync } from 'esbuild'
import { sentReferenceRule, createClientState, draftKey, serializeReference, parseAddress, parseReference, resourceAddress, openDeviceUi, cacheLabel } from '../src/client/state.ts'
import type { ClientContext } from '../src/client/contracts.ts'
import type { OutgoingTask } from '../src/lib/types.ts'
import { sessionInWorkspaces } from '../src/client/scope.tsx'
import { taskStatusLabel, taskStatusPresentation } from '../src/client/conversation.ts'
import { setImmediate as nextTick } from 'node:timers/promises'

test('authorization candidates use the host path rules for case, separators and directory boundaries', () => {
  assert.equal(sessionInWorkspaces('e:/work/sub', ['E:\\Work'], 'win32'), true)
  assert.equal(sessionInWorkspaces('E:\\WORK\\sub', ['e:/work/'], 'win32'), true)
  assert.equal(sessionInWorkspaces('E:/work/child/../sub', ['E:/Work'], 'win32'), true)
  assert.equal(sessionInWorkspaces('E:/work-elsewhere', ['E:/work'], 'win32'), false)
  assert.equal(sessionInWorkspaces('E:/work/../private', ['E:/work'], 'win32'), false)
  assert.equal(sessionInWorkspaces('F:/work/sub', ['E:/work'], 'win32'), false)
  assert.equal(sessionInWorkspaces('\\\\HOST\\share\\work\\sub', ['//host/share/Work'], 'win32'), true)
  assert.equal(sessionInWorkspaces('//host/another/work', ['//host/share'], 'win32'), false)
  assert.equal(sessionInWorkspaces('/Work/sub', ['/Work/'], 'linux'), true)
  assert.equal(sessionInWorkspaces('/work/sub', ['/Work'], 'linux'), false)
  assert.equal(sessionInWorkspaces('/Work-elsewhere', ['/Work'], 'darwin'), false)
  assert.equal(sessionInWorkspaces('/Work/child/../../private', ['/Work'], 'linux'), false)
  assert.equal(sessionInWorkspaces('/Work\\sub', ['/Work'], 'linux'), false)
  assert.equal(sessionInWorkspaces('/Work/sub', [], 'linux'), false)
  assert.equal(sessionInWorkspaces('/Work/sub', 'all', 'linux'), true)
})

test('task failures show only the failure phase recorded by the executor', () => {
  const task: OutgoingTask = { id: 'failed', deviceId: 'b', deviceName: 'B', workspacePath: '/work', prompt: 'work', createdAt: '', submission: 'accepted',
    remote: { id: 'failed', sessionId: 's', workspacePath: '/work', prompt: 'work', status: 'error', text: '', createdAt: '', updatedAt: '' } }
  for (const [errorPhase, label] of [[undefined, '任务失败'], ['startup', '启动失败'], ['execution', '执行失败']] as const) {
    task.remote!.errorPhase = errorPhase
    assert.equal(taskStatusLabel('error', errorPhase), label)
    assert.deepEqual(taskStatusPresentation(task, false), { label, running: false })
  }
  assert.equal(taskStatusLabel('completed', 'startup'), '已完成')
})

test('task results render before a pending device state request finishes', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let release!: (value: Response) => void
  const pendingState = new Promise<Response>(resolve => { release = resolve })
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} } } as never
  const task: OutgoingTask = { id: 'failed', deviceId: 'b', deviceName: 'B', workspacePath: '/work', prompt: 'write file', createdAt: '', submission: 'accepted',
    remote: {id: 'failed', sessionId: 's', workspacePath: '/work', prompt: 'write file', status: 'error', error: 'startup failed', text: '', createdAt: '', updatedAt: ''} }
  globalThis.fetch = async url => String(url).endsWith('/state') ? pendingState : Response.json({tasks:[task]})
  const state = createClientState({} as ClientContext)
  const refreshing = state.refresh()
  try {
    await nextTick()
    assert.equal(state.getSnapshot().data, null)
    assert.equal(state.getSnapshot().tasks[0].remote?.error, 'startup failed')
    assert.equal(cacheLabel({ sessionCache: {s: 'empty'} } as never, 's'), '暂无正文')
  } finally {
    release(Response.json({identity:{deviceId:'a'},peers:[]})); await refreshing
    globalThis.fetch = originalFetch; globalThis.window = originalWindow
  }
})

test('desktop opens the authenticated HTTP URL without treating Electron null as a blocked popup', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls: string[] = []
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { deviceId: 'b', sessionId: 'approval-session' })
    return Response.json({url:'http://192.168.1.2:47654/dl/enter?ac=test'})
  }
  globalThis.window = { location:{protocol:'dsh-app:'}, open(url: string) { calls.push(url); return null } } as never
  try {
    await openDeviceUi('b', 'approval-session')
    assert.deepEqual(calls, ['http://192.168.1.2:47654/dl/enter?ac=test'])
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('device previews reuse one tab and retain the selected receipt without closing other plugin or session tabs', () => {
  let tabs = [
    { sessionId: 'local', tabId: 'old1', kind: 'device-link-preview', contentId: 'old-1' },
    { sessionId: 'local', tabId: 'old2', kind: 'device-link-preview', contentId: 'old-2' },
    { sessionId: 'local', tabId: 'file', kind: 'file', contentId: 'file.txt' },
    { sessionId: 'other', tabId: 'other', kind: 'device-link-preview', contentId: 'other-preview' },
  ]
  let activeId = 'file'
  let serial = 0
  const context = {
    layout: { selectPanel() {} },
    sidebarRight: {
      mounted: { getSnapshot: () => 'local' }, openTabs: { getSnapshot: () => tabs },
      active: () => { const tab = tabs.find(tab => tab.tabId === activeId); return tab && { id: tab.tabId, kind: tab.kind } },
      close: (id: string) => { tabs = tabs.filter(tab => tab.tabId !== id) },
      openResource(address: string, options?: { replaceTab?: string; revealIfOpened?: boolean }) {
        const existing = options?.revealIfOpened === false ? undefined : tabs.find(tab => tab.sessionId === 'local' && tab.contentId === address)
        if (options?.replaceTab) tabs = tabs.filter(tab => tab.tabId !== options.replaceTab)
        if (existing && existing.tabId !== options?.replaceTab) { activeId = existing.tabId; return }
        activeId = `new-${++serial}`
        tabs.push({ sessionId: 'local', tabId: activeId, kind: 'device-link-preview', contentId: address })
      },
    },
  } as unknown as ClientContext
  const state = createClientState(context)
  for (const receiptId of ['inspect', 'search', 'read', 'inspect', 'read']) {
    state.preview({ deviceId: 'peer', workspace: '/work', title: receiptId, referenceId: 'ref', receiptId, sourceSessionId: 'local' })
    const previews = tabs.filter(tab => tab.sessionId === 'local' && tab.kind === 'device-link-preview')
    assert.equal(previews.length, 1)
    assert.equal(parseAddress(previews[0].contentId).receiptId, receiptId)
    assert.equal(parseAddress(previews[0].contentId).sourceSessionId, 'local')
    assert.ok(tabs.some(tab => tab.tabId === 'file'))
    assert.ok(tabs.some(tab => tab.tabId === 'other'))
  }
  const reference = { deviceId: 'peer', workspace: '/work', title: '工作区', referenceId: 'ref' }
  assert.equal(parseAddress(resourceAddress(reference)).receiptId, undefined)
})

test('sending a reference includes a locator without loading session contents; excerpts stay explicit', async () => {
  const previous = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    return new Response(JSON.stringify({ ok: true, descriptor: { id: 'ref1', kind: 'session', sessionId: 's1', deviceId: 'peer', device: 'Lab', title: 'Decision', workspacePath: '/work', capabilities: ['搜索对话文本'], availability: 'cached', referenceCreatedAt: 'now' } }))
  }
  try {
    const wire = await serializeReference('device://peer/session?id=s1', new AbortController().signal)
    assert.deepEqual(calls, ['/device-link/api/reference-prepare'])
    const data = sentReferenceRule.match(wire, 0)!.data
    assert.equal(data.referenceId, 'ref1'); assert.equal('snapshot' in data, false)
    const excerpt = { text: '决定不用 Redis', seq: 7, cachedAt: '2026-11-12T00:00:00Z' }
    const selected = await serializeReference(`device://peer/session?id=s1&excerpt=${encodeURIComponent(JSON.stringify(excerpt))}`, new AbortController().signal)
    assert.deepEqual(sentReferenceRule.match(selected, 0)!.data.excerpt, excerpt)
    assert.equal(sentReferenceRule.match(selected, 0)!.data.ref, 'device://peer/session?id=s1')
  } finally { globalThis.fetch = previous }
})

test('@ input source offers cached workspace/session references without probing an offline peer', async () => {
  const compiled = buildSync({ entryPoints: ['src/client.tsx'], bundle: true, format: 'iife', write: false }).outputFiles[0].text
  let plugin: ReturnType<Parameters<Window['__ModuleLoader__']['load']>[0]['factory']> | undefined
  let trigger: Parameters<ClientContext['inputTriggers']['registerSource']>[0] | undefined
  const routes: string[] = []
  const effects: (() => unknown)[] = []
  vm.runInNewContext(compiled, {
    AbortController, URL,
    window: { __ModuleLoader__: { load(definition: Parameters<Window['__ModuleLoader__']['load']>[0]) { plugin = definition.factory((() => ({})) as never) } } },
    fetch: async (route: string) => {
      routes.push(route)
      return { ok: true, json: async () => ({ ok: true, peers: [{ deviceId: 'remote', name: 'Lab PC', online: false, cachedAt: '2026-11-09T00:00:00Z', cachedSessionIds: ['session-1'], sessionCache: { 'session-1': 'content' }, status: { host: {
        workspaces: [{ id: 'w', title: 'My Project', path: '/My Project' }],
        sessions: [{ id: 'session-1', title: 'Cached work' }, { id: 'session-2', title: 'Metadata only' }],
      } } }] }) }
    },
  })
  assert.ok(plugin)
  const context: Pick<ClientContext, 'slots' | 'effect' | 'inputTriggers'> = {
    slots: { inject(_name, callback) { callback() }, register() {} },
    effect(factory) { effects.push(factory) },
    inputTriggers: { registerSource(value) { trigger = value; return () => {} } },
  }
  plugin.apply(context as ClientContext)
  effects.at(-1)!()
  assert.ok(trigger)
  assert.equal(trigger.trigger, '@')
  const candidates = await trigger.candidates({}, { query: 'Lab', signal: new AbortController().signal })
  assert.equal(candidates.length, 2)
  assert.deepEqual(routes, ['/device-link/api/references'])
  assert.match(candidates[0].value, /path=%2FMy%20Project/)
  assert.equal(trigger.onPick({ candidate: candidates[1] }).insert.ref, 'device://remote/session?id=session-1')
  assert.equal(trigger.onPick({ candidate: candidates[1] }).insert.appearance, 'session')
})

test('session links wait for both host feeds, navigate after their listeners and stop on disposal', async () => {
  const compiled = buildSync({ entryPoints: ['src/client.tsx'], bundle: true, format: 'iife', write: false }).outputFiles[0].text
  for (const disposed of [false, true]) {
    let plugin: ReturnType<Parameters<Window['__ModuleLoader__']['load']>[0]['factory']> | undefined
    const effects: (() => (() => void))[] = []
    const events: string[] = []
    const feed = () => {
      let phase = 'loading'
      const listeners = new Set<() => void>()
      return { getSnapshot: () => ({ phase }), subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
        ready() { phase = 'ready'; for (const listener of listeners) listener() }, listeners }
    }
    const sessions = feed(), workspaces = feed()
    vm.runInNewContext(compiled, {
      AbortController, URL, queueMicrotask,
      window: { location: { href: 'http://device/?deviceLinkSession=approval-session' }, __ModuleLoader__: {
        load(definition: Parameters<Window['__ModuleLoader__']['load']>[0]) { plugin = definition.factory((() => ({})) as never) },
      } },
    })
    assert.ok(plugin)
    plugin.apply({ effect(factory: () => (() => void)) { effects.push(factory) }, slots: { inject() {}, register() {} },
      sessions: { list: sessions }, workspaces: { list: workspaces }, uiWorkspace: { openSession(id: string) { events.push(id) } },
    } as unknown as ClientContext)
    const dispose = effects[2]()
    const stopHost = workspaces.subscribe(() => events.push('host-restoration'))
    sessions.ready()
    await nextTick()
    assert.deepEqual(events, [])
    workspaces.ready()
    assert.deepEqual(events, ['host-restoration'])
    if (disposed) dispose()
    await nextTick()
    assert.deepEqual(events, disposed ? ['host-restoration'] : ['host-restoration', 'approval-session'])
    dispose(); stopHost()
    assert.equal(sessions.listeners.size + workspaces.listeners.size, 0)
  }
})

test('sent reference presentation preserves its locator and explicit excerpt; malformed text remains visible', () => {
  const data = { ref: 'device://remote/session?id=s1', label: 'Cached work（Lab PC）', source: '选中原文', referenceId: 'ref1',
    descriptor: { id: 'ref1', deviceId: 'remote', device: 'Lab PC', kind: 'session', sessionId: 's1', title: 'Cached work', workspacePath: '/workspace',
      referenceCreatedAt: '2026-11-10T00:00:00Z', availability: 'cached', capabilities: ['搜索对话文本'] },
    excerpt: { text: '</device-link-reference> original content', seq: 7, cachedAt: '2026-11-10T00:00:00Z' },
  }
  const wire = `<device-link-reference>\n${JSON.stringify(data).replaceAll('<', '\\u003c')}\n</device-link-reference>`
  const text = `before ${wire} after`
  const node = sentReferenceRule.match(text, 0)!
  assert.equal(node.start, 7)
  assert.equal(text.slice(node.start, node.end), wire)
  assert.deepEqual(node.data, data)
  assert.equal(sentReferenceRule.match(`引用 ${data.label}\n${wire}`, 0)?.start, 0)
  assert.equal(sentReferenceRule.match(text, node.end), undefined)
  assert.equal(sentReferenceRule.match('<device-link-reference>\ninvalid\n</device-link-reference>', 0), undefined)
  for (const malformed of [
    { ...data, referenceId: undefined },
    { ...data, descriptor: { ...data.descriptor, id: 'another-reference' } },
    { ...data, descriptor: { ...data.descriptor, sessionId: 'another-session' } },
    { ...data, descriptor: { ...data.descriptor, device: {} } },
    { ...data, excerpt: { ...data.excerpt, text: {} } },
    { ...data, excerpt: { ...data.excerpt, seq: '7' } },
  ]) assert.equal(sentReferenceRule.match(`<device-link-reference>\n${JSON.stringify(malformed)}\n</device-link-reference>`, 0), undefined)
})

test('device locators require a target and validate excerpt metadata before serialization', () => {
  for (const ref of ['device://remote/session', 'device://remote/workspace?path=', 'device:///session?id=s1', 'device://remote/workspace?path=/work&id=s1', 'device://remote/session?id=s1&path=/work']) assert.throws(() => parseReference(ref), /设备引用无效/)
  for (const excerpt of [null, { text: 'text', cachedAt: 'now', seq: -1 }, { text: 'text', cachedAt: 'now', path: {} }, { text: 'text', cachedAt: 'now', revision: 1 }]) {
    assert.throws(() => parseReference(`device://remote/session?id=s1&excerpt=${encodeURIComponent(JSON.stringify(excerpt))}`), /选中文字无效/)
  }
})

test('browser submission persists its identity before a lost response and restores target drafts', async () => {
  const originalFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const storage = new Map<string,string>()
  let savedTask: OutgoingTask | undefined
  let submissions=0
  globalThis.window = {localStorage:{getItem:(key: string)=>storage.get(key)??null,setItem:(key: string,value: string)=>storage.set(key,value)}} as never
  const data = {identity:{deviceId:'local'},peers:[{deviceId:'remote',name:'Remote'}]}
  globalThis.fetch = async (url, init) => {
    const route=String(url).split('/').at(-1)
    if(route==='task-start') {
      submissions++
      const input=JSON.parse(String(init?.body)) as { id: string }
      const persisted=JSON.parse(storage.get('device-link-0.4:local')!) as { localTasks: Record<string, OutgoingTask> }
      const local = persisted.localTasks[input.id]
      assert.equal(local.prompt,'task')
      savedTask={...local,submission:'accepted',remote:{id:input.id,sessionId:'session',status:'running',workspacePath:local.workspacePath,prompt:local.prompt,createdAt:local.createdAt,updatedAt:local.createdAt,text:''}}
      throw new Error('response lost')
    }
    return {ok:true,json:async()=>route==='state'?data:{tasks:savedTask?[savedTask]:[]}} as Response
  }
  try {
    const state=createClientState({} as never)
    await state.refresh()
    const workspace={deviceId:'remote',workspace:'/work',title:'Work'}
    const other={...workspace,sessionId:'another'}
    state.setDraft(other,{text:'other draft'})
    const result=await state.submitTask(workspace,{text:'task',selection:{provider:'p',model:'m'}})
    assert.equal(result.submission,'pending')
    assert.equal(state.getSnapshot().execution?.taskId,result.id)
    const restored=createClientState({} as never)
    await restored.refresh()
    assert.equal(restored.getSnapshot().execution?.taskId,result.id)
    assert.equal(restored.getSnapshot().tasks[0].id,result.id)
    assert.equal(restored.getSnapshot().drafts[draftKey(other)].text,'other draft')
    assert.equal(submissions,1)
  } finally {globalThis.fetch=originalFetch;globalThis.window=previousWindow}
})

for (const response of ['lost', 'stale'] as const) test(`a ${response} submission response cannot replace a task already confirmed by refresh`, async () => {
  const originalFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const storage = new Map<string, string>()
  let savedTask: OutgoingTask | undefined
  let rejectSubmission!: (reason: Error) => void
  let resolveSubmission!: (response: Response) => void
  const submissionResponse = new Promise<Response>((resolve, reject) => { rejectSubmission = reject; resolveSubmission = resolve })
  globalThis.window = { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } } as never
  globalThis.fetch = async (url, init) => {
    const route = String(url).split('/').at(-1)
    if (route === 'task-start') {
      const input = JSON.parse(String(init?.body)) as { id: string }
      const persisted = JSON.parse(storage.get('device-link-0.4:local')!) as { localTasks: Record<string, OutgoingTask> }
      const local = persisted.localTasks[input.id]
      savedTask = { ...local, submission: 'accepted', remote: {
        id: local.id, sessionId: 'session', workspacePath: local.workspacePath, prompt: local.prompt,
        status: 'completed', createdAt: local.createdAt, updatedAt: new Date(Date.parse(local.createdAt) + 1000).toISOString(), text: 'done',
      } }
      return submissionResponse
    }
    return { ok: true, json: async () => route === 'state'
      ? { identity: { deviceId: 'local' }, peers: [{ deviceId: 'remote', name: 'Remote' }] }
      : { tasks: savedTask ? [savedTask] : [] } } as Response
  }
  try {
    const state = createClientState({} as never)
    await state.refresh()
    const submitting = state.submitTask({ deviceId: 'remote', workspace: '/work', title: 'Work' }, { text: 'task' })
    await state.refresh()
    assert.equal(state.getSnapshot().tasks[0].remote?.status, 'completed')
    if (response === 'lost') rejectSubmission(new Error('late connection failure'))
    else {
      assert.ok(savedTask?.remote)
      const earlierTask: OutgoingTask = { ...savedTask, remote: { ...savedTask.remote, status: 'running', updatedAt: savedTask.createdAt, text: '' } }
      resolveSubmission({ ok: true, json: async () => ({ task: earlierTask }) } as Response)
    }
    const result = await submitting
    assert.equal(result.remote?.status, 'completed')
    assert.equal(state.getSnapshot().tasks[0].submission, 'accepted')
    assert.equal(state.getSnapshot().tasks[0].remote?.text, 'done')
    const persisted = JSON.parse(storage.get('device-link-0.4:local')!) as { localTasks: Record<string, OutgoingTask> }
    assert.deepEqual(persisted.localTasks, {})
  } finally { globalThis.fetch = originalFetch; globalThis.window = previousWindow }
})

for (const action of ['submission', 'refresh', 'cancel'] as const) test(`a late ${action} response returns the latest approval state`, async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} } } as never
  let release!: (response: Response) => void
  const response = new Promise<Response>(resolve => { release = resolve })
  let requested: OutgoingTask | undefined
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)) as { id: string }
    requested = { id: input.id, deviceId: 'b', deviceName: 'B', workspacePath: '/work', prompt: 'work', createdAt: '2026-11-13T00:00:00Z', submission: 'accepted',
      checkedAt: '2026-11-13T00:00:01Z', remote: { id: input.id, sessionId: 's', workspacePath: '/work', prompt: 'work', text: '', status: 'running', createdAt: '', updatedAt: '2026-11-13T00:00:00Z' } }
    return response
  }
  try {
    const state = createClientState({} as ClientContext)
    const pending = action === 'submission' ? state.submitTask({ deviceId: 'b', workspace: '/work', title: 'Work' }, { text: 'work' })
      : action === 'refresh' ? state.refreshTask('task') : state.cancelTask('task')
    assert.ok(requested?.remote)
    const latest: OutgoingTask = { ...requested, checkedAt: '2026-11-13T00:00:02Z', remote: { ...requested.remote, pendingInput: { kind: 'approval' } } }
    state.putTask(latest)
    release(Response.json({ task: requested }))
    const result = await pending
    assert.equal(result.remote?.pendingInput?.kind, 'approval')
    assert.equal(result, state.getSnapshot().tasks[0])
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('focus refreshes active tasks immediately and coalesces overlapping focus events', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalDocument = globalThis.document
  const win = new EventTarget(), doc = new EventTarget()
  globalThis.window = Object.assign(win,{localStorage:{getItem:()=>null,setItem(){}}}) as never
  globalThis.document = Object.assign(doc,{visibilityState:'visible'}) as never
  const task: OutgoingTask = {id:'focus',deviceId:'b',deviceName:'B',workspacePath:'/work',prompt:'work',createdAt:'',submission:'accepted',remote:{id:'focus',sessionId:'s',workspacePath:'/work',prompt:'work',text:'',status:'running',createdAt:'',updatedAt:'2026-11-13T00:00:00Z'}}
  let reads=0, release: (()=>void) | undefined
  const block = new Promise<void>(resolve=>{release=resolve})
  let shouldBlock=false
  globalThis.fetch = async url => {
    if(String(url).endsWith('/state')) return Response.json({identity:{deviceId:'a'},peers:[]})
    if(String(url).endsWith('/tasks')) return Response.json({tasks:[task]})
    reads++; if(shouldBlock) await block
    return Response.json({task:{...task,checkedAt: shouldBlock ? '2026-11-13T00:00:02Z' : '2026-11-13T00:00:01Z',remote:{...task.remote,pendingInput:shouldBlock ? {kind:'approval'} : undefined}}})
  }
  const state=createClientState({} as ClientContext)
  let stop=()=>{}
  try {
    await state.refresh(); stop=state.start(); await nextTick(); await nextTick()
    const before=reads; shouldBlock=true
    win.dispatchEvent(new Event('focus')); win.dispatchEvent(new Event('focus')); doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(reads,before+1)
    release!(); await nextTick(); await nextTick()
    assert.equal(state.getSnapshot().tasks[0].remote?.pendingInput?.kind,'approval')
    await state.refresh()
    assert.equal(state.getSnapshot().tasks[0].remote?.pendingInput?.kind,'approval','older task list must not erase the newer live approval snapshot')
  } finally {release!();stop();globalThis.fetch=originalFetch;globalThis.window=originalWindow;globalThis.document=originalDocument}
})
