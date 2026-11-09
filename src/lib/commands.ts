import type { HostContext } from './host.js'
import type { LoadRuntime } from '../index.js'
import { diagnose } from './network.js'
import { errorMessage } from './types.js'

export function registerDeviceCommands(ctx: HostContext, { load }: { load: LoadRuntime }): () => void {
  return ctx.commands.register({
    name: 'device', description: '配对、诊断、查看设备与离线会话，向远端工作区委派任务',
    input: { hint: 'status | allow | pair <地址> <配对码> | diagnose <地址> | list | open <设备> | sync <设备> | session <设备> <会话> | delegate 设备 | 工作区 | 任务 | revoke <设备> | untrust <设备>' },
    async handler({ rawInput }) {
      try {
        const { store, server, connector } = await load()
        const [command = 'status', ...args] = rawInput.trim().split(/\s+/)
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
          case 'untrust': {
            const device = server.trusted().find(item => item.deviceId === args.join(' ') || item.name === args.join(' '))
            if (!device) throw new Error('没有这个已授权设备')
            result = { revoked: await server.revoke(device.deviceId) }
            break
          }
          case 'delegate': {
            const [device, workspacePath, ...parts] = rawInput.slice('delegate'.length).split('|').map(item => item.trim())
            const peer = connector.peerByRef(device)
            if (!peer || !workspacePath || !parts.join('|')) throw new Error('用法 /device delegate 设备 | 工作区绝对路径 | 任务')
            result = await connector.delegate(peer, { workspacePath, task: parts.join('|') })
            break
          }
          default: {
            const peer = connector.peerByRef(command === 'session' ? args[0] : args.join(' '))
            if (!peer) throw new Error('没有这个设备，先使用 /device list')
            if (command === 'open') result = await connector.access(peer)
            else if (command === 'sync') result = await connector.sync(peer, true)
            else if (command === 'revoke') result = await connector.revoke(peer)
            else if (command === 'session') result = connector.cachedSession(peer, args[1])
            else throw new Error('未知设备命令')
          }
        }
        return { kind: 'success', text: JSON.stringify(result, null, 2) }
      } catch (error) { return { kind: 'error', text: errorMessage(error) } }
    },
  })
}
