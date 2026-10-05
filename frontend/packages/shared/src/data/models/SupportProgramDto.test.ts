import { describe, expect, it } from 'vitest'

import { supportProgramDetailDtoSchema, toSupportProgramDetail } from './SupportProgramDto'

const detail = {
  sourceCode: 'KSTARTUP', id: '179197', title: '창업 지원', organization: '창업진흥원', summary: '사업 내용',
  categories: ['사업화'], regions: ['전국'], targetDescription: '지원 대상: 창업기업', applicationPeriod: '상시',
  applicationStartDate: null, applicationEndDate: null, status: 'OPEN', sourceName: 'K-Startup',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=179197',
  evidenceQuestionSupported: false, applicationRoute: { method: null, url: null, type: 'UNKNOWN' },
}

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
