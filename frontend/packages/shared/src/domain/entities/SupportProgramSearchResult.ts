import type { SupportProgram } from './SupportProgram'
import type { SupportProgramConversationContext } from './SupportProgramConversation'

/** 이번 검색에서 추천한 최대 5건과 현재 공개된 공고를 구분합니다. */
export type SupportProgramSearchResult = {
  query: string
  programs: SupportProgram[]
  totalCount: number
  resultToken: string | null
  expiresAt: string | null
}

export type RestoredSupportProgramSearchResult = SupportProgramSearchResult & {
  context: SupportProgramConversationContext
}
