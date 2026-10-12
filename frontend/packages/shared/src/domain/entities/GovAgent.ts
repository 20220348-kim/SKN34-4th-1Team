import type { SupportProgramInterpretation, SupportProgramInterpretRequest } from './SupportProgramConversation'
import type { SupportProgramEvidenceAnswer } from './SupportProgramEvidenceAnswer'
import type { SupportProgramIdentity } from '../repositories/SupportProgramRepository'
import type { PartnerRecruitmentConditions } from './PartnerRecruitmentRecommendation'

export type GovAgentProgram = SupportProgramIdentity & { title: string }
export type GovAgentRequest = { conversation: SupportProgramInterpretRequest; selectedProgram: SupportProgramIdentity | null }
export type GovAgentResult =
  | { outcome: 'SEARCH'; interpretation: SupportProgramInterpretation }
  | { outcome: 'EVIDENCE'; program: SupportProgramIdentity; evidence: SupportProgramEvidenceAnswer }
  | { outcome: 'APPLICATION'; program: SupportProgramIdentity; message: string }
  | { outcome: 'COMBINATION_REVIEW'; program: SupportProgramIdentity | null; message: string }
  | { outcome: 'PARTNERS'; message: string; partnerConditions: PartnerRecruitmentConditions }
  | { outcome: 'NEEDS_PROGRAM' | 'UNSUPPORTED'; message: string }
export type GovAgentEvidence = { program: GovAgentProgram; answer: SupportProgramEvidenceAnswer }
/** 선택 공고와 생성한 준비 건의 연결입니다. 소유권·양식·작업 결과는 기존 신청 준비 API에서 다시 확인합니다. */
export type GovAgentApplication = { program: GovAgentProgram; message: string; preparationId?: number }
/** 처음 선택한 공고는 미리 채울 입력일 뿐이며, 실제 비교 대상은 검토 API의 저장 내용을 따릅니다. */
export type GovAgentReview = { program: GovAgentProgram | null; message: string; reviewId?: number }
/** 대화에서 읽은 모집글 조건입니다. 조건 없이 저장된 이전 기록은 [conditions]가 없고, 그때는 내 정보만으로 고릅니다. */
export type GovAgentPartners = { message: string; conditions?: PartnerRecruitmentConditions }
