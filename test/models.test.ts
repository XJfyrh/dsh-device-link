import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { executionContext, selectForTask, eventSelection } from '../src/lib/models.ts'
import { collectHostFacts, eventMessages } from '../src/lib/host-facts.ts'
import { conversationTurns, taskStatusPresentation } from '../src/client/conversation.ts'
import type { HostAgent, HostContext, HostEvent, HostServices } from '../src/lib/host.ts'
import type { ModelSelection, OutgoingTask } from '../src/lib/types.ts'
const root = path.resolve('workspace')
const defaultModel = {provider:'p',model:'default'}
const chosen = {provider:'p',model:'chosen',reasoningEffort:'high'}
const catalog = {default:defaultModel,groups:[{id:'p',name:'Provider',models:[{id:'default',name:'Default'},{id:'chosen',name:'Chosen',reasoning:{efforts:[{id:'high',name:'High'}]}}]}],failures:[]}
function fixture() {
  const events: HostEvent[] = []
  let selected: ModelSelection = defaultModel
  const agent: HostAgent = {id:'s',status:'idle',options:defaultModel,model:{current:()=>selected,select:value=>{selected=value}},session:{id:'s',header:{id:'s',cwd:root},seq:0,snapshotEvents:()=>events}}
  const services: Partial<HostServices> = {
    agents:{get:()=>agent,list:()=>[agent]},sessions:{get:()=>agent.session,list:()=>[agent.session]},
    agentDefaultModel:{currentSelection:()=>defaultModel},llm:{resolveCallConfig:async input=>input},
    sessionController:{create:async()=>({sessionId:'s'}),resolveAgent:async()=>({agent}),prompt:async()=>{},cancel:async()=>{},modelCatalog:async()=>catalog,
      list:async()=>({items:[{sessionId:'s',cwd:root,updatedAt:124,agentAvailable:true,projections:{values:{title:'Readable title'}}}]}),
      agents:{serializeImageAdmission:async(_agent,operation)=>operation()}},
  }
  return {agent,events,ctx:{get:name=>services[name]} as Pick<HostContext,'get'>}
}
test('session model selection is validated and does not change device defaults',async()=>{
  const f=fixture()
  await selectForTask(f.ctx,f.agent,chosen)
  assert.deepEqual((await executionContext(f.ctx,root,'s')).selected,chosen)
  assert.deepEqual((await executionContext(f.ctx,root)).selected,defaultModel)
  await assert.rejects(()=>selectForTask(f.ctx,f.agent,{...chosen,model:'removed'}),/不可用/)
  await assert.rejects(()=>selectForTask(f.ctx,f.agent,{...chosen,reasoningEffort:'removed'}),/不可用/)
  f.agent.status='running'
  await assert.rejects(()=>selectForTask(f.ctx,f.agent,chosen),/正在执行/)
  await assert.rejects(()=>executionContext(f.ctx,path.resolve('different'),'s'),/不属于/)
})

test('archived selection separates adapter defaults from explicit next-prompt choices', () => {
  const header: HostEvent = { seq: 1, type: 'request/header', data: { header: { config: chosen, adapterDefaults: { reasoningEffort: true } } } }
  assert.deepEqual(eventSelection([header]), { provider: chosen.provider, model: chosen.model })
  assert.deepEqual(eventSelection([{ ...header, data: { header: { config: chosen } } }]), chosen)
  const pending: HostEvent = { seq: 2, type: 'model/selection', data: chosen }
  assert.deepEqual(eventSelection([header, pending]), chosen)
  assert.deepEqual(eventSelection([pending, { ...header, seq: 3 }]), { provider: chosen.provider, model: chosen.model })
  assert.deepEqual(eventSelection([pending, { seq: 3, type: 'request/header', data: { header: { config: defaultModel } } }]), chosen)
})
test('durable titles and request identities survive history projection',async()=>{
  const f=fixture()
  f.events.push({seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',time:123,data:{source:{kind:'user',rpcId:'request-1'},content:'first human task'}},
    {seq:2,type:'request/header',data:{header:{config:chosen}}},
    {seq:3,type:'assistant/message',time:124,data:{turn:1,message:{content:'answer'}}},
    {seq:4,type:'session/title',data:{title:'Readable title'}})
  const facts=await collectHostFacts(f.ctx)
  assert.equal(facts.sessions[0].title,'Readable title')
  assert.equal(facts.sessions[0].updatedAt,124)
  const messages=eventMessages(f.events)
  assert.equal(messages[0].requestId,'request-1')
  assert.equal(messages[1].requestId,'request-1')
  assert.deepEqual(messages[1].selection,chosen)
})
test('history and task results merge by request identity without hiding repeated text',()=>{
  const task = (id:string,request:string):OutgoingTask=>({id,deviceId:'d',deviceName:'Device',workspacePath:root,prompt:'repeat',createdAt:'2026-11-10T01:00:00Z',submission:'accepted',remote:{id,sessionId:'s',workspacePath:root,prompt:'repeat',promptRequestId:request,status:'completed',createdAt:'',updatedAt:'2026-11-10T01:01:00Z',text:'answer'}})
  const snapshot={device:'Device',deviceId:'d',cachedAt:'2026-11-10T01:02:00Z',session:{id:'s',title:'Title',cwd:root,live:true,updatedAt:1,truncated:false,evidence:[],evidenceTruncated:false,messages:[{seq:1,requestId:'r1',role:'user' as const,text:'repeat'},{seq:2,requestId:'r1',role:'assistant' as const,text:'answer'},{seq:3,requestId:'r2',role:'user' as const,text:'repeat'},{seq:4,requestId:'r2',role:'assistant' as const,text:'answer'}]}}
  const turns=conversationTurns([task('1','r1'),task('2','r2')],snapshot)
  assert.equal(turns.length,2)
  assert.deepEqual(turns.map(turn=>turn.messages.length),[2,2])
  assert.deepEqual(turns.map(turn=>turn.task?.id),['1','2'])
})

test('running presentation stops on lost contact, cancellation and terminal results', () => {
  const task: OutgoingTask = { id: 'task', deviceId: 'device', deviceName: 'Device', workspacePath: root, prompt: 'work', createdAt: '', submission: 'accepted',
    remote: { id: 'task', sessionId: 'session', workspacePath: root, prompt: 'work', status: 'running', createdAt: '', updatedAt: '', text: '' } }
  assert.deepEqual(taskStatusPresentation(task, true), { label: '执行中', running: true })
  assert.deepEqual(taskStatusPresentation(task, false), { label: '状态待更新', running: false })
  assert.deepEqual(taskStatusPresentation({ ...task, connectionError: 'timeout' }, true), { label: '状态待更新', running: false })
  assert.deepEqual(taskStatusPresentation({ ...task, cancelRequested: true }, true), { label: '正在停止', running: false })
  for (const status of ['queued', 'stopping', 'completed', 'error', 'stopped', 'interrupted'] as const) {
    assert.equal(taskStatusPresentation({ ...task, remote: { ...task.remote!, status } }, true).running, false)
  }
  assert.deepEqual(taskStatusPresentation({ ...task, cancelRequested: true, remote: { ...task.remote!, status: 'completed' } }, false), { label: '已完成', running: false })
  assert.deepEqual(taskStatusPresentation({ ...task, submission: 'pending', remote: undefined, connectionError: 'timeout' }, false), { label: '待确认送达', running: false })
})

test('an empty cached session still presents its failed request without fabricating assistant output', () => {
  const evidence = { id: 'task', promptRequestId: 'request', prompt: 'create hello.txt', status: 'error' as const,
    error: 'model unavailable', errorPhase: 'startup' as const, text: '', createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:01Z', truncated: false }
  const snapshot = { device: 'Device', deviceId: 'd', cachedAt: '2026-11-13T00:00:02Z', session: {
    id: 's', title: 'create hello.txt', cwd: root, live: false, updatedAt: 0, messages: [], evidence: [], evidenceTruncated: false, truncated: false, tasks: [evidence],
  } }
  const [turn] = conversationTurns([], snapshot)
  assert.deepEqual(turn.messages, [{ role: 'user', text: 'create hello.txt' }])
  assert.equal(turn.task?.remote?.error, 'model unavailable')
  assert.deepEqual(taskStatusPresentation(turn.task!, false), { label: '启动失败', running: false })
  assert.equal(conversationTurns([turn.task!], snapshot).length, 1)
})
