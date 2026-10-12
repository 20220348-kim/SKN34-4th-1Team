import type { SupportProgram } from './SupportProgram'
import type { SupportProgramConversationContext } from './SupportProgramConversation'

/**
 * 순위 매기기에 보낸 후보 수와 사유별로 추천에서 뺀 후보 수입니다. 한 후보는 먼저 걸린 사유 하나로만 셉니다
 * (요청과 관련도 낮음 → 지원 대상 불일치 → 지역 불일치). 조건을 빼고 다시 찾은 결과 수를 보장하지 않습니다.
 */
export type SupportProgramSearchExclusionCounts = {
  candidateCount: number
  lowRelevance: number
  target: number
  region: number
}

/** 이번 검색에서 추천한 최대 5건과 현재 공개된 공고를 구분합니다. */
export type SupportProgramSearchResult = {
  query: string
  programs: SupportProgram[]
  totalCount: number
  resultToken: string | null
  expiresAt: string | null
  /** 순위 매기기까지 간 검색에서만 있습니다. 이전 서버·복원 결과·빈 검색어는 없거나 null입니다. */
  exclusionCounts?: SupportProgramSearchExclusionCounts | null
}

export type RestoredSupportProgramSearchResult = SupportProgramSearchResult & {
  context: SupportProgramConversationContext
}
