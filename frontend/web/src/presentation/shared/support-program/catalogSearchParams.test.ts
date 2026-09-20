import { describe, expect, it } from 'vitest'

import { defaultCatalogFilters, readCatalogFilters, writeCatalogFilters } from './catalogSearchParams'

describe('카탈로그 URL 필터', () => {
  it.each(['MSIT', 'CNTRADE_NOTICE'] as const)('%s 출처와 접수 상태·페이지를 복원하고 K-Startup 조건은 제외한다', (sourceCode) => {
    const filters = { ...defaultCatalogFilters, sourceCode, status: 'UNKNOWN' as const, region: '충남', page: 2 }
    expect(readCatalogFilters(writeCatalogFilters(filters))).toEqual(filters)
    expect(readCatalogFilters(new URLSearchParams({ sourceCode, startupStage: '3년미만', applicantType: '일반인', founderAge: '만 40세 이상' })))
      .toMatchObject({ sourceCode, status: 'OPEN', startupStage: '', applicantType: '', founderAge: '' })
    const params = writeCatalogFilters({ ...filters, startupStage: '3년미만', applicantType: '일반인', founderAge: '만 40세 이상' })
    expect(params.get('sourceCode')).toBe(sourceCode)
    for (const key of ['startupStage', 'applicantType', 'founderAge']) expect(params.has(key)).toBe(false)
  })

  it('K-Startup 조건과 페이지를 왕복 보존하고 빈 값은 URL에 넣지 않는다', () => {
    const filters = { ...defaultCatalogFilters, sourceCode: 'KSTARTUP' as const, page: 3,
      startupStage: '예비창업자', applicantType: '1인 창조기업', founderAge: '만 20세 이상 ~ 만 39세 이하' }
    const params = writeCatalogFilters(filters)
    expect(readCatalogFilters(params)).toEqual(filters)
    expect([...params.values()].every(Boolean)).toBe(true)
    expect(params.has('keyword')).toBe(false)
    expect(writeCatalogFilters(defaultCatalogFilters).toString()).toBe('mode=filter')
  })

  it.each(['', 'BIZINFO', 'unknown', 'KSTARTUP '])('출처 %j에서는 K-Startup 전용 조건을 복원하지 않는다', (sourceCode) => {
    const filters = readCatalogFilters(new URLSearchParams({ sourceCode, startupStage: '3년미만', applicantType: '일반인', founderAge: '만 40세 이상' }))
    expect(filters.sourceCode).toBe(sourceCode === 'BIZINFO' ? 'BIZINFO' : '')
    expect(filters).toMatchObject({ startupStage: '', applicantType: '', founderAge: '' })
  })

  it('기업마당·전체로 쓰는 URL에 오래된 추가 조건을 섞지 않는다', () => {
    for (const sourceCode of ['', 'BIZINFO'] as const) {
      const params = writeCatalogFilters({ ...defaultCatalogFilters, sourceCode,
        startupStage: '3년미만', applicantType: '일반인', founderAge: '만 40세 이상' })
      expect(params.has('startupStage')).toBe(false)
      expect(params.has('applicantType')).toBe(false)
      expect(params.has('founderAge')).toBe(false)
    }
  })

  it('유효한 추가 조건의 공백만 정리하고 긴 값·제어 문자를 제외한다', () => {
    const filters = readCatalogFilters(new URLSearchParams({ sourceCode: 'KSTARTUP',
      startupStage: ' 3년미만 ', applicantType: '가'.repeat(101), founderAge: '연령\u0000' }))
    expect(filters).toMatchObject({ sourceCode: 'KSTARTUP', startupStage: '3년미만', applicantType: '', founderAge: '' })
  })
})
