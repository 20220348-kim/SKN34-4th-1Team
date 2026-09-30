import { applicationPreparationPageSchema, applicationPreparationSchema } from '@govbiz/shared/data/models/ApplicationPreparationDto'
import { reviewPageSchema, reviewSchema, runPageSchema } from '@govbiz/shared/data/models/CombinationReviewDto'
import type { ApplicationPreparationSummary, ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { CombinationReview, RunSummary } from '@govbiz/shared/domain/entities/CombinationReview'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { apiRequest } from './client'

export type PreparationReview = { review: CombinationReview; latestRun: RunSummary | null }

export async function listPreparations(token: string, signal?: AbortSignal): Promise<ApplicationPreparationSummary[]> {
  const items: ApplicationPreparationSummary[] = []
  let beforeId: number | null = null
  do {
    const page = applicationPreparationPageSchema.parse(await apiRequest(`/api/v1/application-preparations?size=50${beforeId === null ? '' : `&beforeId=${beforeId}`}`, { accessToken: token, signal }))
    if (page.items.some((item) => (beforeId !== null && item.id >= beforeId) || items.some((previous) => previous.id === item.id))
      || (page.nextBeforeId !== null && beforeId !== null && page.nextBeforeId >= beforeId)) throw new Error('신청 준비 페이지 응답이 올바르지 않습니다.')
    items.push(...page.items)
    beforeId = page.nextBeforeId
  } while (beforeId !== null)
  return items
}

export async function listPreparationReviews(token: string, signal?: AbortSignal): Promise<PreparationReview[]> {
  const items: { id: number }[] = []
  let beforeId: number | null = null
  do {
    const page = reviewPageSchema.parse(await apiRequest(`/api/v1/combination-reviews?size=50${beforeId === null ? '' : `&beforeId=${beforeId}`}`, { accessToken: token, signal }))
    if (page.items.some((item) => (beforeId !== null && item.id >= beforeId) || items.some((previous) => previous.id === item.id))
      || (page.nextBeforeId !== null && beforeId !== null && page.nextBeforeId >= beforeId)) throw new Error('중복 검토 페이지 응답이 올바르지 않습니다.')
    items.push(...page.items)
    beforeId = page.nextBeforeId
  } while (beforeId !== null)
  const results: PreparationReview[] = []
  for (let offset = 0; offset < items.length; offset += 6) {
    results.push(...await Promise.all(items.slice(offset, offset + 6).map(async ({ id }) => {
      const [payload, runsPayload] = await Promise.all([
        apiRequest(`/api/v1/combination-reviews/${id}`, { accessToken: token, signal }),
        apiRequest(`/api/v1/combination-reviews/${id}/runs?size=1`, { accessToken: token, signal }),
      ])
      const review = reviewSchema.parse(payload)
      if (review.id !== id) throw new Error('요청한 중복 검토와 응답이 다릅니다.')
      return { review, latestRun: runPageSchema.parse(runsPayload).items[0] ?? null }
    })))
  }
  return results
}

export async function updatePreparationProgress(item: ApplicationPreparationSummary, progressStage: ApplicationProgressStage, token: string, signal?: AbortSignal) {
  const result = applicationPreparationSchema.parse(await apiRequest(`/api/v1/application-preparations/${item.id}/progress-stage`, {
    method: 'PUT', accessToken: token, signal, body: { expectedProgressRevision: item.progressRevision, progressStage },
  }))
  if (result.id !== item.id || result.progressRevision !== item.progressRevision + 1 || result.progressStage !== progressStage
    || result.form.sourceCode !== item.sourceCode || result.form.sourceProgramId !== item.sourceProgramId) {
    throw new Error('진행 단계 저장 응답이 요청과 다릅니다.')
  }
  return result
}

export function getPreparationWebUrl(path: string, identity?: SupportProgramIdentity) {
  if (!/^\/app\/(application-preparations|combination-reviews)\/(new|[1-9]\d*(\/documents|\/runs\/[1-9]\d*)?)$/.test(path)) throw new Error('지원하지 않는 준비 화면입니다.')
  const configured = process.env.EXPO_PUBLIC_WEB_BASE_URL?.trim()
  if (!configured) throw new Error('웹 주소가 설정되지 않았습니다. 앱의 공개 웹 주소 설정을 확인해 주세요.')
  let origin: URL
  try { origin = new URL(configured) } catch { throw new Error('웹 주소 설정을 확인해 주세요.') }
  const localHost = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(origin.hostname)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || (origin.protocol !== 'https:' && !(__DEV__ && origin.protocol === 'http:' && localHost))) throw new Error('웹 주소는 HTTPS origin이어야 합니다. 개발 중에는 로컬 HTTP 주소를 사용할 수 있습니다.')
  const url = new URL(path, origin.origin)
  if (identity) { url.searchParams.set('sourceCode', identity.sourceCode); url.searchParams.set('sourceProgramId', identity.sourceProgramId) }
  return url.href
}
