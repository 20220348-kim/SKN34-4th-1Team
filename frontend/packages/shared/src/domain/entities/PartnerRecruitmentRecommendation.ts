import type { SupportProgramIdentity } from '../repositories/SupportProgramRepository'
import type { PartnerRecruitmentSummary, PartnerRole } from './PartnerRecruitment'

/**
 * 맞춤 추천 조건입니다. 찾는 역할·지역(짧은 시·도 이름)·공고는 모집글을 거르고, 분야 말은 거르지 않고 순서만 올립니다.
 * 모두 비어 있으면 회사 정보·협업 설정·관심 공고만으로 고릅니다.
 */
export type PartnerRecruitmentConditions = {
  seekingRoles: PartnerRole[]
  regions: string[]
  keywords: string[]
  program: SupportProgramIdentity | null
}

export const emptyPartnerRecruitmentConditions: PartnerRecruitmentConditions = { seekingRoles: [], regions: [], keywords: [], program: null }

export type PartnerMatchReasonType = 'MY_PROGRAM' | 'KEYWORD' | 'CAPABILITY' | 'SAME_REGION' | 'ROLE'

/** 카드에 보여 줄 이유입니다. 값은 공고 이름·겹친 역량·분야 말·지역·역할이고 문장은 화면이 만듭니다. */
export type PartnerMatchReason = { type: PartnerMatchReasonType; values: string[]; programSource: 'SAVED' | 'PREPARATION' | null }

/** 거르지 않았지만 확인할 점입니다. 다른 희망 지역, 업력을 몰라 확인하지 못한 최소 업력(년)입니다. */
export type PartnerMatchCaution = { type: 'OTHER_REGION' | 'COMPANY_AGE'; value: string }

export type PartnerRecruitmentRecommendation = {
  recruitment: PartnerRecruitmentSummary
  reasons: PartnerMatchReason[]
  cautions: PartnerMatchCaution[]
}

export type PartnerRecruitmentRecommendations = {
  items: PartnerRecruitmentRecommendation[]
  /** 조건에 맞는 전체 건수입니다. */
  total: number
  /** 무엇을 기준으로 골랐는지입니다. 지역은 짧은 시·도 이름이고 알 수 없으면 null입니다. */
  basis: { hasCompany: boolean; profileSet: boolean; roles: PartnerRole[]; capabilityCount: number; myProgramCount: number; region: string | null }
  /** 거르는 조건 하나를 뺐을 때 남는 모집글 수입니다. */
  relax: { type: 'ROLE' | 'REGION' | 'PROGRAM'; count: number }[]
  /** 아직 아무도 모집글을 쓰지 않은 내 관심 공고입니다. */
  suggestedProgram: (SupportProgramIdentity & { title: string }) | null
}

/** 맞춤 추천 조회의 분야 말 개수·길이 한도입니다. Core API와 같습니다. */
export const partnerRecruitmentKeywordMaxCount = 3
export const partnerRecruitmentKeywordMaxLength = 30
