import type { RestoredSupportProgramSearchResult, SupportProgramSearchResult } from '../entities/SupportProgramSearchResult'
import type { SupportProgramDetail } from '../entities/SupportProgram'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../entities/SupportProgramCatalog'
import type { SupportProgramEvidenceAnswer } from '../entities/SupportProgramEvidenceAnswer'
import type { SupportProgramSearchReadiness } from '../entities/SupportProgramSearchReadiness'
import type { SupportProgramInterpretation, SupportProgramInterpretRequest } from '../entities/SupportProgramConversation'

export type SupportProgramSearch = {
  query: string
  acceptingOnly?: boolean
  companyConditions?: SupportProgramCompanyConditions
}

/** 사용자가 직접 확인한 현재 기업 조건입니다. 미입력 필드는 적합을 의미하지 않습니다. */
export type SupportProgramCompanyConditions = {
  region?: string
  industry?: string
  establishedOn?: string
  foundedYear?: number
  supportPurpose?: string
}

/** 서로 다른 제공처의 같은 원본 공고 ID를 구분하는 공개 식별자입니다. */
export type SupportProgramIdentity = {
  sourceCode: string
  sourceProgramId: string
}

/** 특정 공고의 공식 원문에 대해 사용자가 직접 보낸 질문입니다. */
export type SupportProgramEvidenceQuestion = SupportProgramIdentity & {
  question: string
}

/** 제공처 지원 여부와 일시 장애는 답변 없음과 구분되는 사용자 흐름입니다. */
export type SupportProgramEvidenceQuestionResult =
  | { outcome: 'answer'; answer: SupportProgramEvidenceAnswer }
  | { outcome: 'not-supported' }
  | { outcome: 'unavailable' }

/** 채팅 기능이 Data Layer의 구현 세부사항과 분리되도록 하는 Domain 포트입니다. */
export interface SupportProgramRepository {
  browseCatalog(command: SupportProgramCatalogFilters, signal?: AbortSignal): Promise<SupportProgramCatalog>
  interpretConversation(command: SupportProgramInterpretRequest, signal?: AbortSignal): Promise<SupportProgramInterpretation>
  search(command: SupportProgramSearch, signal?: AbortSignal): Promise<SupportProgramSearchResult>
  restoreSearch(resultToken: string, signal?: AbortSignal): Promise<RestoredSupportProgramSearchResult>
  getSearchReadiness(signal?: AbortSignal): Promise<SupportProgramSearchReadiness>
  getDetail(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SupportProgramDetail | null>
  answerEvidenceQuestion(
    command: SupportProgramEvidenceQuestion,
    signal?: AbortSignal,
  ): Promise<SupportProgramEvidenceQuestionResult>
}
