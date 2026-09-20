import { z } from 'zod'

import type {
  SupportProgramSearchReadiness,
} from '../../domain/entities/SupportProgramSearchReadiness'

const sourceSearchStateSchema = z.enum([
  'PREPARING',
  'SEARCHABLE',
  'SEARCHABLE_WITH_SYNC_FAILURE',
  'UNAVAILABLE',
])

const sourceReadinessSchema = z.object({
  sourceCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  sourceName: z.string().min(1),
  searchState: sourceSearchStateSchema,
  programCount: z.number().int().nonnegative(),
  indexReady: z.boolean(),
  lastSuccessfulSyncAt: z.string().datetime({ offset: true }).nullable(),
  lastFailedSyncAt: z.string().datetime({ offset: true }).nullable(),
})

/** 검색 준비 상태 endpoint의 런타임 HTTP 계약입니다. */
export const supportProgramSearchReadinessDtoSchema = z.object({
  searchState: sourceSearchStateSchema.or(z.literal('SEARCHABLE_WITH_PARTIAL_SOURCES')),
  programCount: z.number().int().nonnegative(),
  indexReady: z.boolean(),
  lastSuccessfulSyncAt: z.string().datetime({ offset: true }).nullable(),
  lastFailedSyncAt: z.string().datetime({ offset: true }).nullable(),
  sources: z.array(sourceReadinessSchema),
})

export type SupportProgramSearchReadinessDto = z.infer<
  typeof supportProgramSearchReadinessDtoSchema
>

/** 상태 endpoint의 DTO를 화면과 UseCase가 사용할 Domain 값으로 복사합니다. */
export function toSupportProgramSearchReadiness(
  dto: SupportProgramSearchReadinessDto,
): SupportProgramSearchReadiness {
  return {
    searchState: dto.searchState,
    programCount: dto.programCount,
    indexReady: dto.indexReady,
    lastSuccessfulSyncAt: dto.lastSuccessfulSyncAt,
    lastFailedSyncAt: dto.lastFailedSyncAt,
    sources: dto.sources.map((source) => ({ ...source })),
  }
}
