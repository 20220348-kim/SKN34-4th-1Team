import { describe, expect, it } from 'vitest'

import { companyInitial, programDeadlineLabel, recruitmentDday, recruitmentDeadlineText } from './partnerRecruitmentLabels'

describe('companyInitial', () => {
  it('법인 형태 표기를 건너뛰고 상호의 첫 글자를 고른다', () => {
    expect(companyInitial('(주) 미래중앙')).toBe('미')
    expect(companyInitial('(주)미래중앙')).toBe('미')
    expect(companyInitial('주식회사 한빛정밀')).toBe('한')
    expect(companyInitial('㈜넥스트웨이브')).toBe('넥')
    expect(companyInitial('유한책임회사 오션푸드')).toBe('오')
    expect(companyInitial('사단법인 청년창업협회')).toBe('청')
    expect(companyInitial('삼성전자(주)')).toBe('삼')
  })

  it('앞의 기호와 공백은 건너뛰고, 글자가 없으면 물음표다', () => {
    expect(companyInitial('  - 데이터랩')).toBe('데')
    expect(companyInitial('42Labs')).toBe('4')
    expect(companyInitial('(주)')).toBe('주')
    expect(companyInitial('')).toBe('?')
    expect(companyInitial('---')).toBe('?')
  })
})

describe('모집·공고 마감 표시', () => {
  // 서울 2026-10-06 오전 9시(UTC 자정)입니다.
  const today = new Date('2026-10-06T00:00:00Z')

  it('모집 중인 글의 D-day 배지는 shared D-day 글자와 색 단계이고 마감·지난 날짜·잘못된 날짜에는 없다', () => {
    expect(recruitmentDday('2026-10-06', false, today)).toEqual({ label: '오늘 마감', tone: 'urgent' })
    expect(recruitmentDday('2026-10-11', false, today)).toEqual({ label: 'D-5', tone: 'urgent' })
    expect(recruitmentDday('2026-10-20', false, today)).toEqual({ label: 'D-14', tone: 'soon' })
    expect(recruitmentDday('2026-11-30', false, today)).toEqual({ label: 'D-55', tone: 'later' })
    expect(recruitmentDday('2026-10-11', true, today)).toBeNull()
    expect(recruitmentDday('2026-10-05', false, today)).toBeNull()
    expect(recruitmentDday('2026-02-30', false, today)).toBeNull()
  })

  it('카드 오른쪽에는 모집 마감일을 쓰고, 공고 마감일은 화면 날짜 형식으로 쓴다', () => {
    expect(recruitmentDeadlineText('2026-10-11')).toBe('모집 마감일 2026.10.11')
    expect(recruitmentDeadlineText('2026-02-30')).toBe('모집 마감일 확인 필요')
    expect(programDeadlineLabel('2026-10-07')).toBe('공고 마감 2026.10.07')
    expect(programDeadlineLabel(null)).toBe('공고 마감일 미정')
  })
})
