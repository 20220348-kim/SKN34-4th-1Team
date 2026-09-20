import type { PartnerRecruitment, PartnerRecruitmentSummary } from '../../domain/entities/PartnerRecruitment'
import type { PartnerRecruitmentPage } from '../../domain/entities/PartnerRecruitmentQuery'

/** 모집 API에 의존하지 않고 목록·상세 화면과 조건 흐름을 검증하기 위한 테스트 전용 모집글입니다. 실제 공고·기업이 아닙니다. */
export const partnerRecruitmentSummaries: PartnerRecruitmentSummary[] = [
  {
    id: 101,
    title: 'AI 실증 과제 데이터 구축·라벨링 참여기관 구합니다',
    seekingRole: 'PARTICIPANT',
    seekingCount: 1,
    region: '서울',
    capabilities: ['데이터 구축', '라벨링'],
    recruitmentDeadline: '2026-09-20',
    status: 'OPEN',
    isMine: false,
    proposalCount: 0,
    company: { companyName: '데이터브릿지 주식회사', region: '서울특별시', industry: '정보통신업', foundedYear: 2021, isEmailVerified: true, isBusinessVerified: true },
    program: { title: '서울 AI 스타트업 실증 지원사업', organization: '서울경제진흥원', applicationEndDate: '2026-09-30' },
    createdAt: '2026-09-05T10:00:00',
  },
  {
    id: 102,
    title: '스마트공장 고도화 과제, 제조 현장 보유 기업과 함께 하실 분',
    seekingRole: 'LEAD',
    seekingCount: 1,
    region: '전국',
    capabilities: ['제조 현장 보유'],
    recruitmentDeadline: '2026-09-24',
    status: 'OPEN',
    isMine: false,
    proposalCount: 0,
    company: { companyName: '비전솔루션', region: '경기도', industry: '정보통신업', foundedYear: 2019, isEmailVerified: true, isBusinessVerified: true },
    program: { title: '2026 스마트제조 혁신 지원사업', organization: '중소벤처기업부', applicationEndDate: '2026-10-08' },
    createdAt: '2026-09-07T10:00:00',
  },
  {
    id: 103,
    title: '해외 전시회 공동 참가, 동남아 유통망 있는 기업 찾습니다',
    seekingRole: 'PARTICIPANT',
    seekingCount: 2,
    region: '전국',
    capabilities: ['해외 유통'],
    recruitmentDeadline: '2026-09-27',
    status: 'OPEN',
    isMine: false,
    proposalCount: 0,
    company: { companyName: '그린푸드랩', region: '부산광역시', industry: '제조업', foundedYear: 2018, isEmailVerified: false, isBusinessVerified: true },
    program: { title: '수출 유망 중소기업 해외전시 지원', organization: '코트라', applicationEndDate: '2026-10-15' },
    createdAt: '2026-09-03T10:00:00',
  },
  {
    id: 104,
    title: '문서 분류 AI 사업화 과제, 공공 레퍼런스 보유 주관기관 찾습니다',
    seekingRole: 'LEAD',
    seekingCount: 1,
    region: '서울',
    capabilities: ['공공기관 레퍼런스', '사업 총괄 경험'],
    recruitmentDeadline: '2026-10-05',
    status: 'OPEN',
    isMine: true,
    proposalCount: 0,
    company: { companyName: '테스트 기업 주식회사', region: '서울특별시', industry: '정보통신업', foundedYear: 2024, isEmailVerified: false, isBusinessVerified: true },
    program: { title: '서울 AI 스타트업 실증 지원사업', organization: '서울경제진흥원', applicationEndDate: '2026-09-30' },
    createdAt: '2026-09-08T10:00:00',
  },
]

export const partnerRecruitmentPage: PartnerRecruitmentPage<PartnerRecruitmentSummary> = {
  recruitments: partnerRecruitmentSummaries,
  total: partnerRecruitmentSummaries.length,
  page: 1,
  pageSize: 20,
  totalPages: 1,
}

/** 첫 예시 모집글의 상세입니다. */
export const partnerRecruitmentDetail: PartnerRecruitment = {
  ...partnerRecruitmentSummaries[0]!,
  body: [
    '저희는 문서 분류 AI를 공공기관 민원 시스템에 적용하는 실증 과제를 준비 중입니다. 학습용 민원 문서 약 5만 건의 정제와 라벨링을 맡아 주실 참여기관을 찾습니다.',
    '예산 배분은 총 사업비의 30% 내외를 참여기관 몫으로 생각하고 있으며, 세부 비율은 협의 가능합니다.',
  ].join('\n\n'),
  myProposal: null,
  ownRole: 'LEAD',
  minimumCompanyAgeYears: null,
  program: {
    sourceCode: 'BIZINFO',
    sourceProgramId: 'fixture-seoul-ai-business',
    title: '서울 AI 스타트업 실증 지원사업',
    organization: '서울경제진흥원',
    summary: '서울 소재 AI 스타트업이 공공·민간 수요처와 실증 과제를 수행하도록 지원합니다. 주관기관 1곳과 참여기관 1곳 이상으로 컨소시엄을 구성해 신청합니다.',
    targetDescription: '서울 소재 창업 7년 이내 AI 기업 (컨소시엄 구성 시 참여기관은 지역 무관)',
    applicationPeriod: '2026. 9. 1. ~ 2026. 9. 30. 18:00',
    applicationEndDate: '2026-09-30',
    sourceUrl: 'https://www.bizinfo.go.kr',
  },
  updatedAt: '2026-09-05T10:00:00',
}
