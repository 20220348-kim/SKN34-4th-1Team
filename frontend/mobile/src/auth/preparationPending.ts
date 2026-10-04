import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'
import { sessionStorageKey } from './storage'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const requestKey = z.string().uuid()
const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discovery'), sourceCode: z.string().min(1), sourceProgramId: z.string().min(1), requestKey }),
  z.object({ kind: z.literal('document'), preparationId: id, expectedRevision: id, requestKey }),
])
export type PendingPreparationRequest = z.infer<typeof schema>
const key = (base: string, email: string) => `${sessionStorageKey(base)}.application.${Array.from(email.toLowerCase()).map(c => c.charCodeAt(0).toString(16)).join('-')}`
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(action: () => Promise<T>) {
  const task = queue.catch(() => undefined).then(action)
  queue = task
  return task
}
async function read(base: string, email: string): Promise<PendingPreparationRequest | null> {
  try {
    const value = await SecureStore.getItemAsync(key(base, email))
    return value === null ? null : schema.parse(JSON.parse(value))
  } catch { throw new Error('보관한 문서 요청을 확인하지 못했어요. 새 분석·생성을 시작하기 전에 다시 확인해 주세요.') }
}
export const readPendingPreparation = (base: string, email: string) => serial(() => read(base, email))
export const savePendingPreparation = (base: string, email: string, pending: PendingPreparationRequest) => serial(async () => {
  const previous = await read(base, email)
  if (previous && JSON.stringify(previous) !== JSON.stringify(pending)) throw new Error('결과를 확인하지 못한 이전 문서 요청이 있어요. 먼저 같은 요청으로 확인해 주세요.')
  await SecureStore.setItemAsync(key(base, email), JSON.stringify(schema.parse(pending)), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
})
export const clearPendingPreparation = (base: string, email: string) => serial(() => SecureStore.deleteItemAsync(key(base, email)))

/** 서버 확인 사이에 새 요청이 보관됐다면 그 기록을 지우지 않는다. */
export const clearPendingPreparationIfUnchanged = (base: string, email: string, expected: PendingPreparationRequest, signal?: AbortSignal) => serial(async () => {
  const current = await read(base, email)
  if (signal?.aborted || !current || JSON.stringify(current) !== JSON.stringify(schema.parse(expected))) return false
  await SecureStore.deleteItemAsync(key(base, email))
  return true
})
