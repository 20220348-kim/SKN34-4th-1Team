import type { MyPartnerProposal } from './PartnerProposal'

/** 컨소시엄에서 맡는 역할입니다. 모집글은 우리 역할 하나와 찾는 역할 하나를 가집니다. */
export type PartnerRole = 'LEAD' | 'PARTICIPANT' | 'DEMAND'

export const partnerRoleLabels: Record<PartnerRole, string> = {
  LEAD: '주관기관',
  PARTICIPANT: '참여기관',
  DEMAND: '수요처',
}

/** 우리 기업이 맡을 수 있는 역할입니다. 수요처는 찾는 역할로만 씁니다. */
export const ownPartnerRoles: readonly PartnerRole[] = ['LEAD', 'PARTICIPANT']
export const seekingPartnerRoles: readonly PartnerRole[] = ['LEAD', 'PARTICIPANT', 'DEMAND']

/** 찾는 기업에 바라는 최소 업력(년)입니다. null이면 무관입니다. */
export const companyAgeYearsRange = { min: 1, max: 50 } as const

/** 서버가 마감일·공고 상태·수동 마감으로 계산한 모집 상태입니다. 화면은 다시 계산하지 않습니다. */
export type PartnerRecruitmentStatus = 'OPEN' | 'CLOSED'

export const seekingCountRange = { min: 1, max: 9 } as const
export const recruitmentTitleMaxLength = 80
export const recruitmentBodyMaxLength = 2000
export const recruitmentCapabilityMaxCount = 10
export const recruitmentCapabilityMaxLength = 30

/** 모집글을 올린 기업입니다. 담당자 이름과 연락처는 제안을 수락한 뒤에만 공개하므로 여기에 두지 않습니다. */
export type PartnerRecruitmentCompany = {
  companyName: string
  region: string
  industry: string
  foundedYear: number
  isEmailVerified: boolean
  /** 작성 기업이 사업자등록번호 조회를 거쳐 등록했는지입니다. 컨소시엄 자격을 보증하지는 않습니다. */
  isBusinessVerified: boolean
}

/** 목록 카드가 필요로 하는 모집글 요약입니다. 본문과 공고 원문은 상세에만 있습니다. */
export type PartnerRecruitmentSummary = {
  id: number
  title: string
  seekingRole: PartnerRole
  seekingCount: number
  /** 공고 분류와 같은 지역 이름(서울, 경기 …)입니다. 전국이면 모든 지역 필터에 포함됩니다. */
  region: string
  capabilities: string[]
  /** YYYY-MM-DD */
  recruitmentDeadline: string
  status: PartnerRecruitmentStatus
  isMine: boolean
  proposalCount: number
  company: PartnerRecruitmentCompany
  program: {
    title: string
    organization: string
    /** YYYY-MM-DD. 접수 마감일이 없는 공고는 null입니다. */
    applicationEndDate: string | null
  }
  createdAt: string
}

/** 상세 화면이 추가로 필요로 하는 값입니다. 공고 원문은 그대로 보여주고 해석을 덧붙이지 않습니다. */
export type PartnerRecruitment = Omit<PartnerRecruitmentSummary, 'program'> & {
  body: string
  /** 조회한 회원이 이 모집글에 보낸 제안입니다. 없거나 비로그인이면 null입니다. */
  myProposal: MyPartnerProposal | null
  ownRole: PartnerRole
  minimumCompanyAgeYears: number | null
  program: {
    sourceCode: string
    sourceProgramId: string
    title: string
    organization: string
    summary: string
    targetDescription: string
    applicationPeriod: string
    applicationEndDate: string | null
    sourceUrl: string
  }
  updatedAt: string
}

/** 모집글 작성 입력입니다. 공고는 제공처 식별자 조합으로 가리키고 기업은 세션의 등록 기업을 씁니다. */
export type PartnerRecruitmentInput = {
  sourceCode: string
  sourceProgramId: string
  title: string
  body: string
  ownRole: PartnerRole
  seekingRole: PartnerRole
  seekingCount: number
  region: string
  minimumCompanyAgeYears: number | null
  capabilities: string[]
  /** YYYY-MM-DD */
  recruitmentDeadline: string
}

/** 모집글 수정 입력입니다. 묶인 공고는 바꿀 수 없으므로 공고 식별자가 없습니다. */
export type PartnerRecruitmentContentInput = Omit<PartnerRecruitmentInput, 'sourceCode' | 'sourceProgramId'>
