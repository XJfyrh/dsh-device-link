import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { buildSync } from 'esbuild'
import { sentReferenceRule, createClientState, draftKey } from '../src/client/state.ts'
import type { ClientContext } from '../src/client/contracts.ts'
import type { OutgoingTask } from '../src/lib/types.ts'

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
      return { ok: true, json: async () => ({ ok: true, peers: [{ deviceId: 'remote', name: 'Lab PC', online: false, cachedAt: '2026-11-09T00:00:00Z', cachedSessionIds: ['session-1'], status: { host: {
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

test('sent reference presentation preserves a complete snapshot and malformed text remains visible', () => {
  const data = { ref: 'device://remote/session?id=s1', label: 'Lab PC › Cached work', source: 'historical context', snapshot: {
    device: 'Lab PC', deviceId: 'remote', cachedAt: '2026-11-10T00:00:00Z', session: { id: 's1', title: 'Cached work', cwd: '/workspace', updatedAt: 1, live: false, truncated: false,
      messages: [{ role: 'user', text: '</device-link-reference> original content' }, { role: 'assistant', text: 'answer' }],
    },
  } }
  const wire = `<device-link-reference>\n${JSON.stringify(data).replaceAll('<', '\\u003c')}\n</device-link-reference>`
  const text = `before ${wire} after`
  const node = sentReferenceRule.match(text, 0)!
  assert.equal(node.start, 7)
  assert.equal(text.slice(node.start, node.end), wire)
  assert.deepEqual(node.data, data)
  assert.equal(sentReferenceRule.match(`引用 ${data.label}\n${wire}`, 0)?.start, 0)
  assert.equal(sentReferenceRule.match(text, node.end), undefined)
  assert.equal(sentReferenceRule.match('<device-link-reference>\ninvalid\n</device-link-reference>', 0), undefined)
  const malformed = JSON.stringify({ ...data, snapshot: { ...data.snapshot, session: { ...data.snapshot.session, messages: [null] } } })
  assert.equal(sentReferenceRule.match(`<device-link-reference>\n${malformed}\n</device-link-reference>`, 0), undefined)
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
