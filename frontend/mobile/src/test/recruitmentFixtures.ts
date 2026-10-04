import type { PartnerRecruitment } from '@govbiz/shared/domain/entities/PartnerRecruitment'

export const recruitmentToday = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
export const recruitmentDateAfter = (days: number) => new Date(Date.parse(`${recruitmentToday}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
export const ownedRecruitment: PartnerRecruitment = {
  id: 19, title: '기존 협업 모집', body: '기존에 입력한 협업 소개', ownRole: 'PARTICIPANT', seekingRole: 'DEMAND', seekingCount: 2,
  region: '경기', capabilities: ['현장 실증', '품질 검증'], minimumCompanyAgeYears: 3,
  recruitmentDeadline: recruitmentDateAfter(5), status: 'OPEN', isMine: true, proposalCount: 2, myProposal: null,
  createdAt: `${recruitmentToday}T09:00:00+09:00`, updatedAt: `${recruitmentToday}T09:00:00+09:00`,
  company: { companyName: '등록 기업', region: '경기', industry: '제조업', foundedYear: 2020, isEmailVerified: true, isBusinessVerified: true },
  program: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_123', title: '연결된 지원사업', organization: '지원 기관', summary: '공고 본문',
    targetDescription: '제조 중소기업', applicationPeriod: '접수 기간', applicationEndDate: recruitmentDateAfter(10),
    sourceUrl: 'https://www.bizinfo.go.kr/program' },
}
