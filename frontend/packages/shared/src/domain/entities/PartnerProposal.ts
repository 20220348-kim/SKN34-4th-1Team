import type { PartnerRecruitmentStatus } from './PartnerRecruitment'

/** 서버가 응답·철회·경과 시간·모집 상태로 계산한 제안 상태입니다. 화면은 다시 계산하지 않습니다. */
export type PartnerProposalStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED'

export const partnerProposalStatusLabels: Record<PartnerProposalStatus, string> = {
  PENDING: '응답 대기',
  ACCEPTED: '수락',
  DECLINED: '거절',
  WITHDRAWN: '철회',
  EXPIRED: '만료',
}

/** 상태 칩의 색 역할입니다. 화면들이 같은 매핑을 씁니다. */
export const partnerProposalStatusTones: Record<PartnerProposalStatus, 'ok' | 'warn' | 'muted' | 'info'> = {
  PENDING: 'info',
  ACCEPTED: 'ok',
  DECLINED: 'muted',
  WITHDRAWN: 'muted',
  EXPIRED: 'warn',
}

export const proposalMessageMaxLength = 500

/** 받은 제안함과 보낸 제안함입니다. */
export type PartnerProposalBox = 'received' | 'sent'

/** 상대 기업입니다. 기본정보는 프로필 공유를 켰거나 수락됐을 때, 담당자 연락처는 수락됐을 때만 옵니다. */
export type PartnerProposalCounterpart = {
  companyName: string
  isEmailVerified: boolean
  isBusinessVerified: boolean
  profile: { region: string; industry: string; foundedYear: number; homepageUrl: string | null } | null
  contact: { email: string; businessNumber: string } | null
}

export type PartnerProposal = {
  id: number
  status: PartnerProposalStatus
  message: string
  shareProfile: boolean
  /** 내가 보낸 제안이면 true, 내 모집글로 받은 제안이면 false입니다. */
  isSent: boolean
  recruitment: {
    id: number
    title: string
    status: PartnerRecruitmentStatus
    /** YYYY-MM-DD */
    recruitmentDeadline: string
  }
  counterpart: PartnerProposalCounterpart
  createdAt: string
  expiresAt: string
  respondedAt: string | null
}

export type PartnerProposalInput = {
  message: string
  shareProfile: boolean
}

/** 제안함 한 상자입니다. 대기 건수는 배지에 씁니다. */
export type PartnerProposalBoxPage = {
  box: PartnerProposalBox
  proposals: PartnerProposal[]
  pendingCount: number
}

/** 모집글 상세에 실리는 내 제안 요약입니다. 제안한 적이 없으면 null입니다. */
export type MyPartnerProposal = {
  id: number
  status: PartnerProposalStatus
}
