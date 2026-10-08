import type { ReviewCitation } from '../../../../domain/entities/CombinationReview'

const statusTerms: Record<string, string> = {
  NOT_STARTED: '‘시작 전’', IN_PROGRESS: '‘수행 중’', COMPLETED: '‘완료’', STOPPED: '‘중단’',
  UNKNOWN: '‘미확인’', YES: '‘예’', NO: '‘아니오’',
  NOT_APPLIED: '‘신청 전’', APPLIED: '‘신청함’', ACTIVE: '‘선정 · 수행 중’', FINISHED: '‘받음 · 종료’',
}

/** 모델이 입력의 상태 코드를 문장에 그대로 옮긴 경우 사용자 말로 바꿉니다. 저장된 응답과 원문 인용은 바꾸지 않습니다. */
export function displayReviewText(text: string): string {
  return text.replace(
    /\b(?:NOT_STARTED|IN_PROGRESS|COMPLETED|STOPPED|UNKNOWN|YES|NO|NOT_APPLIED|APPLIED|ACTIVE|FINISHED)\b/g,
    (term) => statusTerms[term] ?? term,
  )
}

/** 같은 인용을 알아보는 열쇠입니다(근거 번호와 인용문이 같으면 같은 인용). */
export function citationKey(citation: ReviewCitation): string {
  return JSON.stringify([citation.evidenceId, citation.quote])
}
