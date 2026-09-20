import { completeSearchResult } from '../fixtures/supportProgramSearchResult'
import { describe, expect, it } from 'vitest'

import { conditionMatchedProgram, relocationReviewRequiredProgram, supportPrograms } from '../fixtures/supportPrograms'
import { isOfficialSupportProgramSourceUrl, supportProgramDtoSchema, supportProgramSearchResponseDtoSchema, toSupportProgram } from './SupportProgramDto'

describe('새 제공처 공식 원문 URL', () => {
  const sources = [{ sourceCode: 'MSIT', host: 'msit.go.kr' }, { sourceCode: 'CNTRADE_NOTICE', host: 'cntrade.chungnam.go.kr' }]

  it.each(sources)('$sourceCode는 공식 도메인·하위 도메인만 허용하고 기간 미확인을 유지한다', ({ sourceCode, host }) => {
    for (const sourceUrl of ['https://' + host + '/notice?id=1', 'https://www.' + host + '/notice', 'http://' + host + '/notice']) {
      expect(isOfficialSupportProgramSourceUrl(sourceCode, sourceUrl)).toBe(true)
      const dto = supportProgramDtoSchema.parse({ ...supportPrograms[0], sourceCode, sourceUrl, status: 'UNKNOWN',
        applicationStartDate: null, applicationEndDate: null, applicationPeriod: '공고 원문 확인' })
      expect(toSupportProgram(dto)).toMatchObject({ sourceCode, sourceUrl, status: 'UNKNOWN',
        applicationStartDate: null, applicationEndDate: null })
    }
  })

  it.each(sources)('$sourceCode의 위장 호스트·다른 제공처·사용자정보·포트·비 HTTP 주소를 차단한다', ({ sourceCode, host }) => {
    const invalid = [
      'https://' + host + '.evil.example/notice', 'https://evil' + host + '/notice',
      'https://user@' + host + '/notice', 'https://' + host + ':8443/notice',
      'https://' + host + '@evil.example/notice', 'ftp://' + host + '/notice',
      'javascript:alert(1)', '//'+ host + '/notice', 'https://www.bizinfo.go.kr/notice',
      'https://' + (sourceCode === 'MSIT' ? 'cntrade.chungnam.go.kr' : 'msit.go.kr') + '/notice',
    ]
    for (const sourceUrl of invalid) {
      expect(isOfficialSupportProgramSourceUrl(sourceCode, sourceUrl)).toBe(false)
      expect(supportProgramDtoSchema.safeParse({ ...supportPrograms[0], sourceCode, sourceUrl }).success).toBe(false)
    }
  })
})

describe('지원사업 자격 판정 HTTP 계약', () => {
  const matched = conditionMatchedProgram.eligibilityReview!

  it('이전 응답의 판정 누락과 명시적 null을 자격 판정 없음으로 유지한다', () => {
    expect(supportProgramDtoSchema.parse({ ...supportPrograms[0], eligibilityReview: undefined }).eligibilityReview)
      .toBeNull()
    expect(supportProgramDtoSchema.parse(supportPrograms[0]).eligibilityReview).toBeNull()
  })

  it.each([conditionMatchedProgram, relocationReviewRequiredProgram])('판정과 중첩 인용을 도메인에 복사한다: $title', (program) => {
    const dto = supportProgramDtoSchema.parse(program)
    const domain = toSupportProgram(dto)
    expect(domain).toEqual(program)
    expect(domain.eligibilityReview).not.toBe(dto.eligibilityReview)
    expect(domain.eligibilityReview?.target).not.toBe(dto.eligibilityReview?.target)
    expect(domain.eligibilityReview?.target.evidence).not.toBe(dto.eligibilityReview?.target.evidence)
    expect(domain.eligibilityReview?.target.evidence[0]).not.toBe(dto.eligibilityReview?.target.evidence[0])
    expect(domain.eligibilityReview?.region.evidence[0]).not.toBe(dto.eligibilityReview?.region.evidence[0])
  })

  it.each([
    { ...matched, status: 'REVIEW_REQUIRED' },
    { ...matched, target: { ...matched.target, status: 'UNKNOWN' } },
    { ...matched, region: { ...matched.region, status: 'UNKNOWN' } },
    { ...matched, target: { ...matched.target, evidence: [] } },
    { ...matched, region: { ...matched.region, evidence: [] } },
    { ...matched, basis: 'TAGS' },
    { ...matched, target: { ...matched.target, status: 'DISQUALIFIED' } },
    { ...matched, target: { ...matched.target, evidence: [...matched.target.evidence, ...matched.target.evidence] } },
    { ...matched, target: { ...matched.target, evidence: [{ field: 'REGIONS', quote: '전국' }] } },
    { ...matched, target: { ...matched.target, explanation: '' } },
    { ...matched, target: { ...matched.target, explanation: '   ' } },
    { ...matched, target: { ...matched.target, evidence: [{ field: 'SUMMARY', quote: ' ' }] } },
  ])('모순된 판정이나 유효한 본문 근거 없는 MATCH를 거부한다 (%#)', (eligibilityReview) => {
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview }).success).toBe(false)
  })

  it('UNKNOWN은 인용 없이 확인이 필요한 이유를 제공할 수 있다', () => {
    const review = {
      ...matched,
      status: 'REVIEW_REQUIRED',
      region: { status: 'UNKNOWN', explanation: '이전 의향을 확인해야 합니다.', evidence: [] },
    }
    expect(supportProgramDtoSchema.parse({ ...conditionMatchedProgram, eligibilityReview: review }).eligibilityReview)
      .toEqual(review)
  })

  it('설명 160·인용 240자의 원시 코드 포인트 상한을 검사하고 공백을 임의 제거하지 않는다', () => {
    const explanation = ` ${'😀'.repeat(158)} `
    const quote = ` ${'😀'.repeat(238)} `
    const review = { ...matched, region: { ...matched.region, explanation, evidence: [{ field: 'SUMMARY', quote }] } }
    expect(supportProgramDtoSchema.parse({ ...conditionMatchedProgram, summary: quote, eligibilityReview: review }).eligibilityReview?.region)
      .toEqual(review.region)
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview: {
      ...review, region: { ...review.region, explanation: `${explanation} ` },
    } }).success).toBe(false)
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview: {
      ...review, region: { ...review.region, evidence: [{ field: 'SUMMARY', quote: `${quote} ` }] },
    } }).success).toBe(false)
  })

  it.each(['target', 'region'] as const)('실제 %s 본문에 없는 인용으로 조건 확인을 표시하지 않는다', (axis) => {
    const eligibilityReview = { ...matched, [axis]: {
      ...matched[axis], evidence: [{ field: 'SUMMARY', quote: '이 공고에 없는 신청 자격' }],
    } }
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview }).success).toBe(false)
  })

  it('다른 필드의 인용이나 공백을 재작성한 인용도 지정한 원문 근거로 인정하지 않는다', () => {
    const parseEvidence = (field: string, quote: string) => supportProgramDtoSchema.safeParse({
      ...conditionMatchedProgram,
      eligibilityReview: { ...matched, target: { ...matched.target, evidence: [{ field, quote }] } },
    }).success
    expect(parseEvidence('SUMMARY', conditionMatchedProgram.targetDescription)).toBe(false)
    expect(parseEvidence('TARGET_DESCRIPTION', conditionMatchedProgram.targetDescription.replaceAll(' ', '  '))).toBe(false)
    expect(parseEvidence('TARGET_DESCRIPTION', conditionMatchedProgram.targetDescription)).toBe(true)
  })

  it('확인 필요 인용에도 같은 원문 일치 규칙을 적용하고 인용 없는 UNKNOWN은 유지한다', () => {
    const review = relocationReviewRequiredProgram.eligibilityReview!
    expect(supportProgramDtoSchema.safeParse({ ...relocationReviewRequiredProgram, eligibilityReview: {
      ...review, region: { ...review.region, evidence: [{ field: 'SUMMARY', quote: '전국 기업 신청 가능' }] },
    } }).success).toBe(false)
    expect(supportProgramDtoSchema.safeParse({ ...relocationReviewRequiredProgram, eligibilityReview: {
      ...review, region: { ...review.region, evidence: [] },
    } }).success).toBe(true)
  })

  it.each(['2026-02-29', '2024-02-30', '2026-13-01', '2026-01-00', '2026-2-01'])('달력상 불가능하거나 잘못된 신청일을 거부한다: %s', (date) => {
    for (const field of ['applicationStartDate', 'applicationEndDate']) {
      expect(supportProgramDtoSchema.safeParse({ ...supportPrograms[0], [field]: date }).success).toBe(false)
    }
  })

  it('윤일·nullable 신청일과 접수 상태·추천 관련성·자격의 독립성을 유지한다', () => {
    const program = { ...relocationReviewRequiredProgram, applicationStartDate: '2024-02-29', applicationEndDate: null, status: 'CLOSED', recommendationScore: 100 }
    expect(supportProgramDtoSchema.parse(program)).toEqual(program)
  })

  it('동일 제공처·원본 ID 중복은 거부하고 다른 제공처의 같은 ID는 유지한다', () => {
    const same = { ...supportPrograms[0], title: '동일 공고의 충돌 제목' }
    expect(supportProgramSearchResponseDtoSchema.safeParse(completeSearchResult({ query: '사업화', programs: [supportPrograms[0], same] })).success).toBe(false)
    const other = { ...same, sourceCode: 'KSTARTUP', sourceUrl: 'https://www.k-startup.go.kr/program' }
    expect(supportProgramSearchResponseDtoSchema.safeParse(completeSearchResult({ query: '사업화', programs: [supportPrograms[0], other] })).success).toBe(true)
  })

  it.each(['\n', '\r', '\t', '\u0000', '\u200b', '\ud800'])('설명과 인용의 제어문자·형식문자·서로게이트를 거부한다 (%#)', (invalid) => {
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview: {
      ...matched, target: { ...matched.target, explanation: `설명${invalid}` },
    } }).success).toBe(false)
    expect(supportProgramDtoSchema.safeParse({ ...conditionMatchedProgram, eligibilityReview: {
      ...matched, region: { ...matched.region, evidence: [{ field: 'SUMMARY', quote: `${invalid}인용` }] },
    } }).success).toBe(false)
  })
})
