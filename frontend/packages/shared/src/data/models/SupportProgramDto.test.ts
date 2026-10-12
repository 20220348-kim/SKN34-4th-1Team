import { describe, expect, it } from 'vitest'

import { supportProgramDetailDtoSchema, supportProgramDtoSchema, toSupportProgram, toSupportProgramDetail } from './SupportProgramDto'

const detail = {
  sourceCode: 'KSTARTUP', id: '179197', title: '창업 지원', organization: '창업진흥원', summary: '사업 내용',
  categories: ['사업화'], regions: ['전국'], targetDescription: '지원 대상: 창업기업', applicationPeriod: '상시',
  applicationStartDate: null, applicationEndDate: null, status: 'OPEN', sourceName: 'K-Startup',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=179197',
  evidenceQuestionSupported: false, applicationRoute: { method: null, url: null, type: 'UNKNOWN' },
}

describe('검색 결과의 다른 지역 한정 가능 표시', () => {
  const searched = {
    sourceCode: 'BIZINFO', id: 'PBLN_1', title: '경북 창업 지원', organization: '경북기관', summary: '사업 내용',
    categories: ['창업'], regions: ['경북'], targetDescription: '경북 소재 창업기업', applicationPeriod: '상시',
    applicationStartDate: null, applicationEndDate: null, status: 'OPEN', sourceName: '기업마당',
    sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_1',
    matchedReasons: ['창업 지원'], recommendationScore: 80, eligibilityReview: null,
  }

  it('표시할 공고에만 도메인 값을 두고 false이거나 이 필드가 없던 응답은 기존 공고 모양을 유지한다', () => {
    expect(toSupportProgram(supportProgramDtoSchema.parse({ ...searched, regionTagMismatch: true })).regionTagMismatch).toBe(true)
    expect(supportProgramDtoSchema.parse(searched)).not.toHaveProperty('regionTagMismatch')
    for (const response of [searched, { ...searched, regionTagMismatch: false }]) {
      expect(toSupportProgram(supportProgramDtoSchema.parse(response))).not.toHaveProperty('regionTagMismatch')
    }
  })

  it('불리언이 아닌 값은 거부한다', () => {
    for (const invalid of ['true', 1, null]) {
      expect(supportProgramDtoSchema.safeParse({ ...searched, regionTagMismatch: invalid }).success).toBe(false)
    }
  })
})

describe('검색 결과의 함께 게시와 원문 질문 지원 여부', () => {
  const searched = {
    sourceCode: 'BIZINFO', id: 'PBLN_1', title: 'AI 창업 지원', organization: '창업진흥원', summary: '사업 내용',
    categories: ['창업'], regions: ['서울'], targetDescription: '창업기업', applicationPeriod: '2026-10-01 ~ 2026-10-31',
    applicationStartDate: '2026-10-01', applicationEndDate: '2026-10-31', status: 'OPEN', sourceName: '기업마당',
    sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_1',
    matchedReasons: [], recommendationScore: 80, eligibilityReview: null,
  }
  const kStartup = {
    sourceCode: 'KSTARTUP', id: '179197', sourceName: 'K-Startup', evidenceQuestionSupported: false,
    sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=179197',
  }

  it('묶인 게시물과 지원 여부를 도메인으로 복사하고 이 필드가 없던 응답은 기존 공고 모양을 유지한다', () => {
    const dto = supportProgramDtoSchema.parse({ ...searched, evidenceQuestionSupported: true, alsoPostedBy: [kStartup] })
    const domain = toSupportProgram(dto)

    expect(domain).toMatchObject({ evidenceQuestionSupported: true, alsoPostedBy: [kStartup] })
    expect(domain.alsoPostedBy?.[0]).not.toBe(dto.alsoPostedBy?.[0])
    for (const response of [searched, { ...searched, evidenceQuestionSupported: false, alsoPostedBy: [] }]) {
      const program = toSupportProgram(supportProgramDtoSchema.parse(response))
      expect(program).not.toHaveProperty('evidenceQuestionSupported')
      expect(program).not.toHaveProperty('alsoPostedBy')
    }
  })

  it('공고와 같은 제공처·겹치는 제공처·공식이 아닌 주소·불리언이 아닌 지원 여부를 거부한다', () => {
    for (const alsoPostedBy of [
      [{ ...kStartup, sourceCode: 'BIZINFO', sourceUrl: searched.sourceUrl }],
      [kStartup, { ...kStartup, id: '179198' }],
      [{ ...kStartup, sourceUrl: 'https://example.com/179197' }],
      [{ ...kStartup, evidenceQuestionSupported: 'false' }],
    ]) {
      expect(supportProgramDtoSchema.safeParse({ ...searched, alsoPostedBy }).success).toBe(false)
    }
  })
})

describe('공고 상세의 공식 문의처·우대 사항·주관 기관 유형', () => {
  it('받은 값을 도메인으로 복사한다', () => {
    const dto = supportProgramDetailDtoSchema.parse({
      ...detail, contact: { department: '창업보육센터', phoneNumber: '0312508269', text: null },
      preferenceDescription: '1인창조, 재창업', supervisingInstitutionType: '공공기관',
    })
    const domain = toSupportProgramDetail(dto)

    expect(domain).toMatchObject({
      contact: { department: '창업보육센터', phoneNumber: '0312508269', text: null },
      preferenceDescription: '1인창조, 재창업', supervisingInstitutionType: '공공기관',
    })
    expect(domain.contact).not.toBe(dto.contact)
  })

  it('이 필드를 보내기 전 서버의 응답과 명시적 null은 값 없음으로 받는다', () => {
    for (const response of [detail, { ...detail, contact: null, preferenceDescription: null, supervisingInstitutionType: null }]) {
      expect(toSupportProgramDetail(supportProgramDetailDtoSchema.parse(response)))
        .toMatchObject({ contact: null, preferenceDescription: null, supervisingInstitutionType: null })
    }
  })

  it('모양이 다른 문의처와 문자열이 아닌 값을 거부한다', () => {
    for (const invalid of [
      { contact: '02-123-4567' },
      { contact: { department: 1, phoneNumber: null, text: null } },
      { contact: { department: null, phoneNumber: null } },
      { preferenceDescription: ['1인창조'] },
      { supervisingInstitutionType: 3 },
    ]) {
      expect(supportProgramDetailDtoSchema.safeParse({ ...detail, ...invalid }).success).toBe(false)
    }
  })
})
