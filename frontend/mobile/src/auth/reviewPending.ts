import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'
import { runRequestSchema } from '@govbiz/shared/data/models/CombinationReviewDto'
import { sessionStorageKey } from './storage'

const pendingSchema = z.object({ reviewId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), request: runRequestSchema })
export type PendingReviewRequest = z.infer<typeof pendingSchema>
const key = (baseUrl: string, email: string) => `${sessionStorageKey(baseUrl)}.review.${Array.from(email.toLowerCase()).map(char => char.charCodeAt(0).toString(16)).join('-')}`
let work: Promise<unknown> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const next = work.catch(() => undefined).then(action)
  work = next
  return next
}
async function read(baseUrl: string, email: string) {
  let value: string | null
  try { value = await SecureStore.getItemAsync(key(baseUrl, email)) }
  catch { throw new Error('보관한 분석 요청을 확인하지 못해 새 분석을 시작할 수 없어요. 저장소 상태를 다시 확인해 주세요.') }
  if (value === null) return null
  let payload: unknown
  try { payload = JSON.parse(value) } catch { throw new Error('보관한 분석 요청을 확인하지 못했어요. 새 분석을 시작하기 전에 운영 확인이 필요해요.') }
  const parsed = pendingSchema.safeParse(payload)
  if (!parsed.success) throw new Error('보관한 분석 요청을 확인하지 못했어요. 새 분석을 시작하기 전에 운영 확인이 필요해요.')
  return parsed.data
}
export const readPendingReview = (baseUrl: string, email: string) => serialize(() => read(baseUrl, email))
export const savePendingReview = (baseUrl: string, email: string, pending: PendingReviewRequest) => serialize(async () => {
  const previous = await read(baseUrl, email)
  if (previous && JSON.stringify(previous) !== JSON.stringify(pending)) throw new Error('완료 여부를 확인하지 못한 다른 분석 요청이 있어요. 먼저 같은 요청으로 확인해 주세요.')
  await SecureStore.setItemAsync(key(baseUrl, email), JSON.stringify(pendingSchema.parse(pending)), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
})
export const clearPendingReview = (baseUrl: string, email: string) => serialize(() => SecureStore.deleteItemAsync(key(baseUrl, email)))
