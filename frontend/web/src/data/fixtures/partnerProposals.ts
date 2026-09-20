import type { PartnerProposal, PartnerProposalBoxPage } from '../../domain/entities/PartnerProposal'

/** 제안 API에 의존하지 않고 제안함·상세 화면과 상태 흐름을 검증하기 위한 테스트 전용 제안입니다. 실제 기업이 아닙니다. */
export const receivedPendingProposal: PartnerProposal = {
  id: 301,
  status: 'PENDING',
  message: '라벨링 운영과 품질 검수를 맡겠습니다. 공공 데이터 구축 실적이 2건 있습니다.',
  shareProfile: true,
  isSent: false,
  recruitment: { id: 104, title: '문서 분류 AI 사업화 과제, 공공 레퍼런스 보유 주관기관 찾습니다', status: 'OPEN', recruitmentDeadline: '2026-10-05' },
  counterpart: {
    companyName: '데이터브릿지 주식회사',
    isEmailVerified: true,
    isBusinessVerified: true,
    profile: { region: '서울특별시', industry: '정보통신업', foundedYear: 2021, homepageUrl: null },
    contact: null,
  },
  createdAt: '2026-09-08T10:00:00',
  expiresAt: '2026-09-15T10:00:00',
  respondedAt: null,
}

export const receivedAcceptedProposal: PartnerProposal = {
  ...receivedPendingProposal,
  id: 302,
  status: 'ACCEPTED',
  message: '해외 유통망을 함께 쓰실 수 있습니다.',
  counterpart: {
    companyName: '그린푸드랩',
    isEmailVerified: false,
    isBusinessVerified: true,
    profile: { region: '부산광역시', industry: '제조업', foundedYear: 2018, homepageUrl: 'https://greenfood.example' },
    contact: { email: 'manager@greenfood.example', businessNumber: '1234567890' },
  },
  respondedAt: '2026-09-09T09:00:00',
}

export const sentPendingProposal: PartnerProposal = {
  id: 303,
  status: 'PENDING',
  message: '데이터 구축과 라벨링 운영을 맡을 수 있습니다.',
  shareProfile: true,
  isSent: true,
  recruitment: { id: 101, title: 'AI 실증 과제 데이터 구축·라벨링 참여기관 구합니다', status: 'OPEN', recruitmentDeadline: '2026-09-20' },
  counterpart: {
    companyName: '데이터브릿지 주식회사',
    isEmailVerified: true,
    isBusinessVerified: true,
    profile: { region: '서울특별시', industry: '정보통신업', foundedYear: 2021, homepageUrl: null },
    contact: null,
  },
  createdAt: '2026-09-09T08:00:00',
  expiresAt: '2026-09-16T08:00:00',
  respondedAt: null,
}

const sentDeclinedProposal: PartnerProposal = {
  ...sentPendingProposal,
  id: 304,
  status: 'DECLINED',
  recruitment: { id: 102, title: '스마트공장 고도화 과제, 제조 현장 보유 기업과 함께 하실 분', status: 'OPEN', recruitmentDeadline: '2026-09-24' },
  counterpart: { companyName: '비전솔루션', isEmailVerified: true, isBusinessVerified: true, profile: null, contact: null },
  respondedAt: '2026-09-09T09:30:00',
}

export const receivedProposalBox: PartnerProposalBoxPage = {
  box: 'received',
  proposals: [receivedPendingProposal, receivedAcceptedProposal],
  pendingCount: 1,
}

export const sentProposalBox: PartnerProposalBoxPage = {
  box: 'sent',
  proposals: [sentPendingProposal, sentDeclinedProposal],
  pendingCount: 1,
}
