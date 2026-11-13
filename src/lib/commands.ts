import type { HostContext } from './host.js'
import type { LoadRuntime } from '../index.js'
import { diagnose } from './network.js'
import { errorMessage } from './types.js'
import { randomUUID } from 'node:crypto'

export function registerDeviceCommands(ctx: HostContext, { load }: { load: LoadRuntime }): () => void {
  return ctx.commands.register({
    name: 'device', description: '配对、诊断、查看设备与离线会话，向设备工作区委派任务',
    input: { hint: 'status | allow | pair <地址> <配对码> | diagnose <地址> | list | trusted | open <设备> | sync <设备> | session <设备> <会话> | delegate 设备 | 工作区 | 任务 | tasks | task <任务 id> | cancel <任务 id> | revoke <设备> | untrust <设备>' },
    async handler({ rawInput }) {
      try {
        const { store, server, connector, outgoingTasks, references } = await load()
        const input = rawInput.trim()
        const [command = 'status', ...args] = (input || 'status').split(/\s+/)
        let result: unknown
        switch (command) {
          case 'status': result = { ...server.info(), identity: store.state().identity }; break
          case 'allow': result = server.openPairing(); break
          case 'pair': {
            const peer = await connector.claim(args[0] ?? '', args[1] ?? '')
            result = { deviceId: peer.deviceId, name: peer.name, baseUrl: peer.baseUrl }
            break
          }
          case 'diagnose': result = await diagnose(args[0]); break
          case 'list': result = await Promise.all(Object.values(store.state().peers).map(peer => connector.sync(peer))); break
          case 'trusted': result = server.trusted(); break
          case 'tasks': result = outgoingTasks.list(); break
          case 'task': result = await outgoingTasks.refresh(args[0] ?? ''); break
          case 'cancel': result = await outgoingTasks.cancel(args[0] ?? ''); break
          case 'untrust': {
            const reference = args.join(' ')
            const trusted = server.trusted()
            const matches = trusted.filter(item => item.name === reference)
            const device = trusted.find(item => item.deviceId === reference) ?? (matches.length === 1 ? matches[0] : undefined)
            if (!device && matches.length > 1) throw new Error('设备名称不唯一，请使用设备 id')
            if (!device) throw new Error('没有这个已授权设备')
            result = { revoked: await server.revoke(device.deviceId) }
            break
          }
          case 'delegate': {
            const [device, workspacePath, ...parts] = input.slice('delegate'.length).split('|').map(item => item.trim())
            const peer = connector.peerByRef(device)
            if (!peer || !workspacePath || !parts.join('|')) throw new Error('用法 /device delegate 设备 | 工作区绝对路径 | 任务')
            result = await outgoingTasks.start(peer, { id: randomUUID(), workspacePath, task: parts.join('|') })
            break
          }
          default: {
            const peer = connector.peerByRef((command === 'session' ? args.slice(0, -1) : args).join(' '))
            if (!peer) throw new Error('没有这个设备，先使用 /device list')
            if (command === 'open') result = await connector.access(peer)
            else if (command === 'sync') result = await connector.sync(peer, true)
            else if (command === 'revoke') {
              result = await connector.revoke(peer)
              await references.removePeer(peer.deviceId)
            }
            else if (command === 'session') result = connector.cachedSession(peer, args.at(-1) ?? '')
            else throw new Error('未知设备命令')
          }
        }
        return { kind: 'success', text: JSON.stringify(result, null, 2) }
      } catch (error) { return { kind: 'error', text: errorMessage(error) } }
    },
  })
}
