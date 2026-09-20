import type { RunRequest } from '../../domain/entities/CombinationReview'
import { runRequestSchema } from '../models/CombinationReviewDto'

const prefix = 'govbiz.review.pending.'
const key = (account: string, review: number) => `${prefix}${encodeURIComponent(account)}.${review}`
/** 응답을 잃은 유료 요청만 탭 내에서 보존한다. 일반 입력 초안·결과는 저장하지 않는다. */
export const reviewRequestJournal = {
  read(account: string, review: number): RunRequest | null {
    const raw = sessionStorage.getItem(key(account, review))
    if (!raw) return null
    // 손상된 기록은 새 유료 요청으로 우회하지 않고 명시적으로 실패시킨다.
    return runRequestSchema.parse(JSON.parse(raw))
  },
  write(account: string, review: number, request: RunRequest) { sessionStorage.setItem(key(account, review), JSON.stringify(request)) },
  remove(account: string, review: number) { sessionStorage.removeItem(key(account, review)) },
  clear() {
    for (const name of Object.keys(sessionStorage)) if (name.startsWith(prefix)) sessionStorage.removeItem(name)
  },
}
