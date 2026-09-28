import { describe, expect, it } from 'vitest'

import { companyInitial } from './partnerRecruitmentLabels'

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
