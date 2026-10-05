import { describe, expect, it } from 'vitest'

import { splitSupportProgramTarget, supportProgramApplicationRouteLabel, supportProgramContactParts } from './SupportProgramSections'

describe('splitSupportProgramTarget', () => {
  it('K-Startup의 지원 대상과 제외 대상 줄을 나눈다', () => {
    expect(splitSupportProgramTarget('KSTARTUP', '지원 대상: 창업 3년 이내 기업\n제외 대상: 휴·폐업 중인 기업'))
      .toEqual({ target: '창업 3년 이내 기업', excluded: '휴·폐업 중인 기업' })
  })

  it('제외 대상만 있으면 지원 대상은 비워 둔다', () => {
    expect(splitSupportProgramTarget('KSTARTUP', '제외 대상: 대기업')).toEqual({ target: '', excluded: '대기업' })
  })

  it('K-Startup이라도 약속한 줄 형식이 아니면 원문 그대로 둔다', () => {
    expect(splitSupportProgramTarget('KSTARTUP', '정보 없음')).toEqual({ target: '정보 없음', excluded: null })
  })

  it('다른 제공처는 같은 글자가 있어도 나누지 않는다', () => {
    const text = '지원 대상: 중소기업\n제외 대상: 대기업'
    expect(splitSupportProgramTarget('BIZINFO', text)).toEqual({ target: text, excluded: null })
  })
})

describe('supportProgramApplicationRouteLabel', () => {
  it.each([
    ['GOOGLE_FORMS', '온라인 신청 (구글 설문)'],
    ['OTHER_ONLINE_FORM', '온라인 신청 (접수 사이트)'],
    ['FILE', '이메일·우편·방문 제출'],
    ['UNKNOWN', null],
  ] as const)('%s 경로의 이름을 돌려준다', (type, label) => {
    expect(supportProgramApplicationRouteLabel({ method: null, url: null, type })).toBe(label)
  })
})

describe('supportProgramContactParts', () => {
  it('K-Startup 담당 부서와 숫자 전화번호를 하이픈 번호와 전화 링크로 잇는다', () => {
    expect(supportProgramContactParts({ department: ' 창업보육센터 ', phoneNumber: '0312508269', text: null })).toEqual([
      { text: '창업보육센터', tel: null },
      { text: ' · ', tel: null },
      { text: '031-250-8269', tel: '0312508269' },
    ])
  })

  it.each([
    ['029088247', '02-908-8247'],
    ['0226259552', '02-2625-9552'],
    ['07041219179', '070-4121-9179'],
    ['01012345678', '010-1234-5678'],
    ['05051234567', '0505-123-4567'],
    ['050712345678', '0507-1234-5678'],
    ['15444781', '1544-4781'],
    ['1357', '1357'],
  ])('국내 번호 규칙에 맞는 %s를 %s로 표시한다', (digits, label) => {
    expect(supportProgramContactParts({ department: null, phoneNumber: digits, text: null })).toEqual([{ text: label, tel: digits }])
  })

  it.each(['13012345678', '031123456789', '02123', '031-250-82', '내선 107'])('규칙에 맞지 않는 번호 %s는 받은 그대로 두고 잇지 않는다', (value) => {
    expect(supportProgramContactParts({ department: null, phoneNumber: value, text: null })).toEqual([{ text: value, tel: null }])
  })

  it('기업마당 문의처 원문 안의 하이픈 전화번호만 잇고 나머지 글자는 그대로 둔다', () => {
    expect(supportProgramContactParts({
      department: null, phoneNumber: null,
      text: '에너지기술평가원 02-3469-8813~4, help@ketep.re.kr / 콜센터 1588-6565(내선 2) / 국번없이 1357',
    })).toEqual([
      { text: '에너지기술평가원 ', tel: null },
      { text: '02-3469-8813', tel: '0234698813' },
      { text: '~4, help@ketep.re.kr / 콜센터 ', tel: null },
      { text: '1588-6565', tel: '15886565' },
      { text: '(내선 2) / 국번없이 1357', tel: null },
    ])
  })

  it('날짜·사업자번호·국제번호처럼 더 긴 숫자의 일부는 전화번호로 잇지 않는다', () => {
    const text = '2026-10-04 접수, 사업자 123-45-67890, 상해 +86-21-5283-5622, 0512-345-67890'
    expect(supportProgramContactParts({ department: null, phoneNumber: null, text })).toEqual([{ text, tel: null }])
  })

  it('빈 값만 있으면 조각이 없다', () => {
    expect(supportProgramContactParts({ department: ' ', phoneNumber: '', text: null })).toEqual([])
  })
})
