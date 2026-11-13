import type { OutgoingTask, SessionMessage } from '../lib/types.js'
import type { SessionSnapshot } from './state.js'

export const statusLabels: Record<string, string> = { pending: '待确认送达', accepted: '已接收', queued: '排队中', running: '执行中', stopping: '正在停止', completed: '已完成', error: '执行失败', stopped: '已停止', interrupted: '跟进已中断', failed: '提交失败', cancelled: '已取消' }
export function taskStatusPresentation(task: OutgoingTask, online: boolean): { label: string; running: boolean } {
  const status = task.remote?.status ?? task.submission
  if (status === 'error' && task.remote?.errorPhase === 'startup') return { label: '启动失败', running: false }
  const active = ['pending', 'accepted', 'queued', 'running', 'stopping'].includes(status)
  if (task.remote && active && (!online || task.connectionError)) return { label: '状态待更新', running: false }
  if (active && task.cancelRequested) return { label: '正在停止', running: false }
  return { label: statusLabels[status], running: status === 'running' }
}
export interface ConversationTurn { key: string; task?: OutgoingTask; messages: SessionMessage[] }
/** Join using the prompt's durable RPC identity. Equal text can be two different turns. */
export function conversationTurns(tasks: OutgoingTask[], snapshot?: SessionSnapshot | null): ConversationTurn[] {
  tasks = [...tasks, ...(snapshot?.session.tasks ?? []).filter(item => !tasks.some(task => task.remote?.id === item.id || item.promptRequestId && task.remote?.promptRequestId === item.promptRequestId))
    .map(item => ({ id: item.id, deviceId: snapshot!.deviceId, deviceName: snapshot!.device, workspacePath: snapshot!.session.cwd,
      prompt: item.prompt, createdAt: item.createdAt, submission: 'accepted' as const,
      remote: { ...item, sessionId: snapshot!.session.id, workspacePath: snapshot!.session.cwd } }))]
  const turns: ConversationTurn[] = []
  for (const message of snapshot?.session.messages ?? []) {
    const key = message.requestId ?? (message.turn === undefined ? `message-${message.seq}` : `turn-${message.turn}`)
    const prior = turns.at(-1)
    if (prior?.key === key) prior.messages.push(message)
    else turns.push({ key, messages: [message] })
  }
  for (const task of [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = task.remote?.promptRequestId
    let turn = key ? turns.find(turn => turn.key === key) : undefined
    if (!turn) { turn = { key: key ?? `task-${task.id}`, messages: [{ role: 'user', text: task.prompt }] }; turns.push(turn) }
    turn.task = task
    if (task.remote?.text && (!snapshot || Date.parse(task.remote.updatedAt) >= Date.parse(snapshot.cachedAt) || !turn.messages.some(message => message.role === 'assistant'))) {
      const last = turn.messages.findLastIndex(message => message.role === 'assistant')
      const answer: SessionMessage = { ...turn.messages[last], role: 'assistant', text: task.remote.text,
        selection: task.remote.provider && task.remote.model ? { provider: task.remote.provider, model: task.remote.model, reasoningEffort: task.remote.reasoningEffort } : undefined }
      if (last < 0) turn.messages.push(answer)
      else turn.messages[last] = answer
    }
  }
  return turns
}
