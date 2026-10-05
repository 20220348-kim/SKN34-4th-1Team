import { applicationPreparationPageSchema, applicationPreparationSchema } from '@govbiz/shared/data/models/ApplicationPreparationDto'
import { reviewPageSchema, reviewSchema, runPageSchema } from '@govbiz/shared/data/models/CombinationReviewDto'
import type { ApplicationPreparationSummary, ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import type { CombinationReview, RunSummary } from '@govbiz/shared/domain/entities/CombinationReview'
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
