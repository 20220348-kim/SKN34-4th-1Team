import { z } from 'zod'

import type { SupportProgramCatalogFilters } from '../../domain/entities/SupportProgramCatalog'
import { supportProgramDtoSchema } from '../models/SupportProgramDto'
import type { SupportProgramHttpContext } from './supportProgramClient'

const startupFacetSchema = z.object({
  startupStages: z.array(z.string().min(1).max(100)),
  applicantTypes: z.array(z.string().min(1).max(100)),
  founderAges: z.array(z.string().min(1).max(100)),
})

const catalogResponseSchema = z.object({
  programs: z.array(supportProgramDtoSchema).max(50),
  total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(1_000_000),
  pageSize: z.number().int().min(1).max(50),
  totalPages: z.number().int().min(0),
  regions: z.array(z.string().min(1).max(100)),
  categories: z.array(z.string().min(1).max(100)),
  startupStages: startupFacetSchema.shape.startupStages.default([]),
  applicantTypes: startupFacetSchema.shape.applicantTypes.default([]),
  founderAges: startupFacetSchema.shape.founderAges.default([]),
}).refine((value) => {
  const expectedCount = Math.max(0, Math.min(value.pageSize, value.total - (value.page - 1) * value.pageSize))
  return value.totalPages === Math.ceil(value.total / value.pageSize)
    && value.programs.length === expectedCount
    && new Set(value.programs.map((program) => JSON.stringify([program.sourceCode, program.id]))).size === value.programs.length
    && value.programs.every((program) => program.recommendationScore === null && program.eligibilityReview === null && program.matchedReasons.length === 0)
    && new Set(value.regions).size === value.regions.length && new Set(value.categories).size === value.categories.length
    && [value.startupStages, value.applicantTypes, value.founderAges].every((options) => new Set(options).size === options.length)
}, '공고 목록의 개수·페이지·자격 미평가 계약이 일치해야 합니다.')

/** 목록 endpoint만 호출합니다. 실패 시 AI 검색으로 대체하지 않습니다. */
export async function browseSupportProgramsApi(context: SupportProgramHttpContext, command: SupportProgramCatalogFilters, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(command).filter(([, value]) => value !== '').map(([key, value]) => [key, String(value)]))
  const response = await context.fetch(`${context.baseUrl}/api/v1/support-programs/catalog?${params}`, {
    headers: { Accept: 'application/json' }, cache: 'no-store', signal,
  })
  if (!response.ok) throw new Error('공고 목록을 불러오지 못했습니다.')
  const body: unknown = await response.json()
  // 구 Core가 알 수 없는 추가 필터를 무시한 응답은 정상 검색 결과로 표시하지 않습니다.
  if ([command.startupStage, command.applicantType, command.founderAge].some(Boolean)
    && !startupFacetSchema.safeParse(body).success) {
    throw new Error('K-Startup 추가 필터를 확인할 수 없는 응답입니다.')
  }
  const catalog = catalogResponseSchema.parse(body)
  if (catalog.page !== command.page || catalog.pageSize !== command.pageSize) throw new Error('요청한 페이지와 응답이 다릅니다.')
  if (command.sourceCode && catalog.programs.some((program) => program.sourceCode !== command.sourceCode)) {
    throw new Error('요청한 출처와 응답이 다릅니다.')
  }
  return catalog
}
