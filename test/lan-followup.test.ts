import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createDelegationRunner } from '../src/lib/delegation.ts'
import type { HostServices, HostEvent, HostAgent } from '../src/lib/host.ts'
import { taskStatusPresentation } from '../src/client/conversation.ts'
import type { OutgoingTask } from '../src/lib/types.ts'

test('delegation attaches the resolved workspace, preserves continuation, and never prompts after registration or attachment failure', async () => {
  const root = path.resolve('workspace')
  const events: HostEvent[] = []
  const agent: HostAgent = { id:'s', status:'idle', options:{}, model:{current:()=>undefined,select(){}}, session:{id:'s',header:{cwd:root},seq:0,snapshotEvents:()=>events} }
  const calls: string[] = []
  let failure = ''
  const services: Partial<HostServices> = {
    workspaceController: {async create({path: target}) { calls.push('register'); assert.equal(target,root); if(failure === 'register') throw new Error('workspace registration failed'); return {workspace:{workspaceId:'w',path:root},created:true} }},
    sessions:{get:()=>agent.session,list:()=>[agent.session]}, agents:{get:()=>agent,list:()=>[agent]},
    sessionController:{list:async()=>({items:[]}),modelCatalog:async()=>{throw new Error('unused')},agents:{serializeImageAdmission:async(_agent,operation)=>operation()},
      async create(input) { calls.push('create'); assert.deepEqual(input,{sessionId:'s',workspaceId:'w'}); if(failure === 'attach') throw new Error('session/workspace-attach-failed'); return {sessionId:'s'} },
      async resolveAgent() {calls.push('resume');return {agent}},async cancel(){},async prompt(input){ calls.push('prompt'); events.push({seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',data:{source:{rpcId:input.requestId}}},{seq:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}) }},
  }
  const runner = createDelegationRunner({ctx:{get:name=>services[name]}})
  const input = {workspacePath:root,task:'hello',sessionId:'s',requestId:'r'}
  assert.equal((await runner.run(input)).status,'completed')
  assert.deepEqual(calls,['register','create','prompt'])
  calls.length=0; events.length=0
  assert.equal((await runner.run({...input,resume:true})).status,'completed')
  assert.deepEqual(calls,['resume','prompt'])
  for (const mode of ['register','attach']) {
    failure=mode; calls.length=0; events.length=0
    assert.equal((await runner.run(input)).status,'error')
    assert.ok(!calls.includes('prompt'))
  }
  failure=''; agent.session.header.cwd=path.resolve('wrong'); calls.length=0
  assert.match((await runner.run(input)).error!, /workspace does not match/)
  assert.ok(!calls.includes('prompt'))
})

test('approval waiting yields to connection loss, cancellation and terminal outcomes', () => {
  const task: OutgoingTask = { id:'t',deviceId:'d',deviceName:'D',workspacePath:'/w',prompt:'p',createdAt:'',submission:'accepted',remote:{id:'t',sessionId:'s',workspacePath:'/w',prompt:'p',text:'',status:'running',createdAt:'',updatedAt:'',pendingInput:{kind:'approval',reason:'test'}} }
  assert.deepEqual(taskStatusPresentation(task,true),{label:'等待权限处理',running:false})
  assert.equal(taskStatusPresentation(task,false).label,'状态待更新')
  assert.equal(taskStatusPresentation({...task,cancelRequested:true},true).label,'正在停止')
  assert.equal(taskStatusPresentation({...task,remote:{...task.remote!,status:'completed'}},true).label,'已完成')
})
