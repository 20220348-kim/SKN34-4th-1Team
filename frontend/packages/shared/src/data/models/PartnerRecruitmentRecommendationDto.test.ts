import { describe, expect, it } from 'vitest'

import { RecommendPartnerRecruitmentsUseCase } from '../../domain/usecases/PartnerRecruitmentUseCases'
import { partnerRecruitmentRecommendationsDtoSchema, toPartnerRecruitmentRecommendations } from './PartnerRecruitmentRecommendationDto'

const recruitment = {
  id: 21, title: 'AI 실증 과제 참여기관 구합니다', body: '본문', ownRole: 'LEAD', seekingRole: 'PARTICIPANT', seekingCount: 1, region: '서울',
  minimumCompanyAgeYears: null, capabilities: ['데이터 구축'], recruitmentDeadline: '2026-10-30', status: 'OPEN', isMine: false, proposalCount: 0,
  myProposal: null, createdAt: '2026-10-01T09:00:00', updatedAt: '2026-10-01T09:00:00',
  company: { companyName: '넥스트웨이브', region: '서울특별시', industry: '정보통신업', foundedYear: 2020, isEmailVerified: true, isBusinessVerified: true },
  program: { sourceCode: 'BIZINFO', sourceProgramId: 'P-1', title: 'AI 실증 지원사업', organization: '기관', applicationEndDate: '2026-12-31' },
}

const payload = {
  items: [{
    recruitment,
    reasons: [{ type: 'CAPABILITY', values: ['데이터 구축'], programSource: null }, { type: 'MY_PROGRAM', values: ['AI 실증 지원사업'], programSource: 'SAVED' }],
    cautions: [{ type: 'OTHER_REGION', value: '부산' }],
  }],
  total: 1,
  basis: { hasCompany: true, profileSet: true, roles: ['PARTICIPANT'], capabilityCount: 1, myProgramCount: 2, region: '서울' },
  relax: [{ type: 'REGION', count: 3 }],
  suggestedProgram: { sourceCode: 'BIZINFO', sourceProgramId: 'P-9', title: '빈 공고' },
}

describe('파트너 맞춤 추천 응답', () => {
  it('reads reasons, cautions, basis and the suggested program from the Core response', () => {
    const result = toPartnerRecruitmentRecommendations(partnerRecruitmentRecommendationsDtoSchema.parse(payload))
    expect(result.items[0]!.recruitment.title).toBe('AI 실증 과제 참여기관 구합니다')
    expect(result.items[0]!.reasons.map((reason) => reason.type)).toEqual(['CAPABILITY', 'MY_PROGRAM'])
    expect(result.items[0]!.cautions).toEqual([{ type: 'OTHER_REGION', value: '부산' }])
    expect(result.basis.region).toBe('서울')
    expect(result.relax).toEqual([{ type: 'REGION', count: 3 }])
    expect(result.suggestedProgram?.title).toBe('빈 공고')
  })

  it('rejects unknown reason kinds instead of showing them', () => {
    const invalid = { ...payload, items: [{ ...payload.items[0], reasons: [{ type: 'AI_GUESS', values: ['x'], programSource: null }] }] }
    expect(partnerRecruitmentRecommendationsDtoSchema.safeParse(invalid).success).toBe(false)
  })

  it('trims and dedupes conditions and sends at most three short keywords', async () => {
    const calls: unknown[] = []
    const useCase = new RecommendPartnerRecruitmentsUseCase({ recommend: async (conditions) => { calls.push(conditions); return toPartnerRecruitmentRecommendations(partnerRecruitmentRecommendationsDtoSchema.parse(payload)) } })
    await useCase.execute({ seekingRoles: ['LEAD'], regions: [' 서울 ', '서울', ''], keywords: [' AI ', 'AI', '데이터', '가'.repeat(31), '라벨링', '물류'], program: null }, 3)
    expect(calls).toEqual([{ seekingRoles: ['LEAD'], regions: ['서울'], keywords: ['AI', '데이터', '라벨링'], program: null }])
  })
})
