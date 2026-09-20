import {
  answerSupportProgramEvidenceQuestionApi,
  getSupportProgramDetailApi,
  getSupportProgramSearchReadinessApi,
  interpretSupportProgramConversationApi,
  searchSupportProgramsApi,
  restoreSupportProgramSearchApi,
  SupportProgramSearchRestoreApiError,
  SupportProgramEvidenceApiError,
  SupportProgramInterpretationApiError,
  SupportProgramRequestApiError,
  SupportProgramSearchTimeoutApiError,
} from '../api/supportProgramApi'
import { toSupportProgram } from '../models/SupportProgramDto'
import { browseSupportProgramsApi } from '../api/supportProgramCatalogApi'
import type { SupportProgramCatalogFilters } from '../../domain/entities/SupportProgramCatalog'
import { toSupportProgramEvidenceAnswer } from '../models/SupportProgramEvidenceAnswerDto'
import { toSupportProgramSearchReadiness } from '../models/SupportProgramSearchReadinessDto'
import { toSupportProgramInterpretation } from '../models/SupportProgramConversationDto'
import type { SupportProgramInterpretRequest } from '../../domain/entities/SupportProgramConversation'
import type { SupportProgramSearchResult } from '../../domain/entities/SupportProgramSearchResult'
import { SupportProgramSearchRestoreError } from '../../domain/errors/SupportProgramSearchRestoreError'
import type { SupportProgram } from '../../domain/entities/SupportProgram'
import { SupportProgramRequestError } from '../../domain/errors/SupportProgramRequestError'
import { SupportProgramInterpretationError } from '../../domain/errors/SupportProgramInterpretationError'
import { SupportProgramSearchTimeoutError } from '../../domain/errors/SupportProgramSearchTimeoutError'
import type { SupportProgramSearchReadiness } from '../../domain/entities/SupportProgramSearchReadiness'
import type {
  SupportProgramRepository,
  SupportProgramEvidenceQuestion,
  SupportProgramEvidenceQuestionResult,
  SupportProgramIdentity,
  SupportProgramSearch,
} from '../../domain/repositories/SupportProgramRepository'

/** Core API DTO를 검증된 Domain 공고로 변환하는 Repository adapter입니다. */
export class SupportProgramRepositoryImpl implements SupportProgramRepository {
  async browseCatalog(command: SupportProgramCatalogFilters, signal?: AbortSignal) {
    const response = await browseSupportProgramsApi(command, signal)
    return { ...response, programs: response.programs.map(toSupportProgram), regions: [...response.regions], categories: [...response.categories] }
  }

  async interpretConversation(command: SupportProgramInterpretRequest, signal?: AbortSignal) {
    try {
      return toSupportProgramInterpretation(await interpretSupportProgramConversationApi(command, signal))
    } catch (error) {
      if (error instanceof SupportProgramInterpretationApiError) throw new SupportProgramInterpretationError(error.reason)
      throw toRequestError(error)
    }
  }

  async search(
    command: SupportProgramSearch,
    signal?: AbortSignal,
  ): Promise<SupportProgramSearchResult> {
    try {
      const response = await searchSupportProgramsApi(command, signal)
      return { ...response, programs: response.programs.map(toSupportProgram) }
    } catch (error) {
      if (error instanceof SupportProgramSearchTimeoutApiError) throw new SupportProgramSearchTimeoutError()
      throw toRequestError(error)
    }
  }

  async restoreSearch(resultToken: string, signal?: AbortSignal) {
    try {
      const response = await restoreSupportProgramSearchApi(resultToken, signal)
      return { ...response, programs: response.programs.map(toSupportProgram), context: {
        ...response.context, companyConditions: { ...response.context.companyConditions },
      } }
    } catch (error) {
      if (signal?.aborted) throw error
      throw new SupportProgramSearchRestoreError(error instanceof SupportProgramSearchRestoreApiError ? error.reason : 'unavailable')
    }
  }

  async getSearchReadiness(signal?: AbortSignal): Promise<SupportProgramSearchReadiness> {
    return toSupportProgramSearchReadiness(
      await getSupportProgramSearchReadinessApi(signal),
    )
  }

  async getDetail(
    identity: SupportProgramIdentity,
    signal?: AbortSignal,
  ): Promise<SupportProgram | null> {
    const dto = await getSupportProgramDetailApi(identity, signal)
    return dto ? toSupportProgram(dto) : null
  }

  async answerEvidenceQuestion(
    command: SupportProgramEvidenceQuestion,
    signal?: AbortSignal,
  ): Promise<SupportProgramEvidenceQuestionResult> {
    try {
      const dto = await answerSupportProgramEvidenceQuestionApi(command, signal)
      return { outcome: 'answer', answer: toSupportProgramEvidenceAnswer(dto) }
    } catch (error) {
      if (error instanceof SupportProgramEvidenceApiError) {
        if (error.status === 422) return { outcome: 'not-supported' }
        if (error.status === 503) return { outcome: 'unavailable' }
      }
      throw toRequestError(error)
    }
  }
}

function toRequestError(error: unknown): unknown {
  return error instanceof SupportProgramRequestApiError
    ? new SupportProgramRequestError(
      error.code === 'SUPPORT_PROGRAM_RATE_LIMITED' ? 'rate-limited' : 'busy',
      error.retryAfterSeconds,
    )
    : error
}
