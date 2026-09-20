import type { PartnerRole } from './PartnerRecruitment'

/**
 * 기업이 파트너 모집에서 어떤 역할과 분야로 협업할지 밝히는 설정입니다. 모집글 상세와 기업 프로필 보기에서
 * 다른 기업에게 보이며 담당자 연락처는 담지 않습니다. 저장한 적이 없으면 `isSet=false`와 기본값입니다.
 */
export type CompanyPartnerProfile = {
  isSet: boolean
  roles: PartnerRole[]
  interestAreas: string[]
  introduction: string
  capabilities: string[]
  updatedAt: string | null
}

export type CompanyPartnerProfileInput = {
  roles: PartnerRole[]
  interestAreas: string[]
  introduction: string
  capabilities: string[]
}

export const companyPartnerProfileLimits = {
  interestAreaMaxCount: 3,
  introductionMaxLength: 200,
  capabilityMaxCount: 5,
  capabilityMaxLength: 30,
} as const

export const emptyCompanyPartnerProfile: CompanyPartnerProfile = {
  isSet: false,
  roles: [],
  interestAreas: [],
  introduction: '',
  capabilities: [],
  updatedAt: null,
}

export type CompanyPartnerProfileField = 'roles' | 'interestAreas' | 'introduction' | 'capabilities'

/** 서버와 같은 규칙으로 검사해 첫 오류 필드를 돌려줍니다. 문제가 없으면 null입니다. */
export function findCompanyPartnerProfileProblem(input: CompanyPartnerProfileInput): CompanyPartnerProfileField | null {
  if (input.roles.length === 0) return 'roles'
  if (input.interestAreas.length > companyPartnerProfileLimits.interestAreaMaxCount) return 'interestAreas'
  if (input.introduction.trim().length > companyPartnerProfileLimits.introductionMaxLength) return 'introduction'
  if (
    input.capabilities.length > companyPartnerProfileLimits.capabilityMaxCount ||
    input.capabilities.some((item) => item.trim().length === 0 || item.length > companyPartnerProfileLimits.capabilityMaxLength) ||
    new Set(input.capabilities).size !== input.capabilities.length
  ) {
    return 'capabilities'
  }
  return null
}
