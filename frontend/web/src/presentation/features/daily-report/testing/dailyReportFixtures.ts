import type { Account } from '../../../../domain/entities/Account'
import type { Company } from '../../../../domain/entities/Company'
import type { DailyReport, DailyReportSettings } from '../../../../domain/entities/DailyReport'

export const reportAccount: Account = {
  email: 'report@example.test', role: 'USER', tier: 'COMPANY', emailVerified: false, hasPassword: true,
  company: { companyName: '리포트 기업', businessNumber: '1234567890' },
}
export const reportCompany: Company = {
  businessNumber: '1234567890', companyName: '리포트 기업', businessStatus: '계속사업자',
  region: '서울특별시', industry: '정보통신업', foundedYear: 2023, homepageUrl: null,
  businessVerifiedAt: '2026-09-09T09:00:00+09:00', updatedAt: '2026-09-09T09:00:00+09:00',
}
export const reportSettings: DailyReportSettings = {
  supportPurpose: 'AI 제품 개발', enabled: false, emailConfirmed: false, emailDeliveryAvailable: true, schedulerEnabled: true, sendHour: 8,
}
export const readyReport: DailyReport = {
  id: 1, reportDate: '2026-09-09', status: 'READY', deliveryStatus: 'NOT_REQUESTED',
  companyName: '리포트 기업', region: '서울특별시', industry: '정보통신업', supportPurpose: 'AI 제품 개발',
  generatedAt: '2026-09-09T09:00:00+09:00', warnings: ['설립일이 없어 업력 조건은 추가 확인이 필요합니다.'], errorMessage: null,
  programs: [{
    sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', title: 'AI 제품 개발 지원',
    sourceUrl: 'https://www.bizinfo.go.kr/detail?id=PBLN_123', applicationPeriod: '2026-09-01 ~ 2026-09-30',
    relevanceScore: 92, matchedReasons: ['AI 제품 개발 목적과 관련 있습니다.'], eligibilityStatus: 'REVIEW_REQUIRED', eligibilityNote: '세부 대상 요건 확인이 필요합니다.',
    evidenceStatus: 'ANSWERED', evidenceAnswer: '사업계획서를 제출해야 합니다.',
    citations: [{ excerpt: '제출서류: 사업계획서', sourceUrl: 'https://www.bizinfo.go.kr/detail?id=PBLN_123' }],
  }],
}
