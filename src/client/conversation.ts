import type { OutgoingTask, SessionMessage } from '../lib/types.js'
import type { SessionSnapshot } from './state.js'

export const statusLabels: Record<string, string> = { pending: '待确认送达', accepted: '已接收', queued: '排队中', running: '执行中', stopping: '正在停止', completed: '已完成', error: '执行失败', stopped: '已停止', interrupted: '跟进已中断', failed: '提交失败', cancelled: '已取消' }
export interface ConversationTurn { key: string; task?: OutgoingTask; messages: SessionMessage[] }
/** Join using the prompt's durable RPC identity. Equal text can be two different turns. */
export function conversationTurns(tasks: OutgoingTask[], snapshot?: SessionSnapshot | null): ConversationTurn[] {
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
