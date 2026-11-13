import { HttpError, type Store } from './types.js'

export function normalizeDeviceName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '请输入设备名称')
  const name = value.trim()
  if (name.length > 64) throw new HttpError(400, '设备名称不能超过 64 个字符')
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new HttpError(400, '设备名称不能包含换行或控制字符')
  if (/[\ud800-\udfff]/u.test(name)) throw new HttpError(400, '设备名称包含无效的 Unicode 字符')
  return name
}

export async function renameDevice(store: Store, value: unknown) {
  const name = normalizeDeviceName(value)
  const state = await store.update(draft => { draft.identity.name = name })
  return state.identity
}
