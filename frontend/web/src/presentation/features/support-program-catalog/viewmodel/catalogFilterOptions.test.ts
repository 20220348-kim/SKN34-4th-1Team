import { describe, expect, it } from 'vitest'

import { defaultCatalogCategories, defaultCatalogRegions, mergeCatalogFilterOptions } from './catalogFilterOptions'

describe('공고 필터 기본 선택지', () => {
  it('지역은 서버 정규값 18개를 기존 가나다순으로 제공한다', () => {
    expect(defaultCatalogRegions).toEqual([
      '강원', '경기', '경남', '경북', '광주', '대구', '대전', '부산', '서울',
      '세종', '울산', '인천', '전국', '전남', '전북', '제주', '충남', '충북',
    ])
    expect(defaultCatalogRegions).toHaveLength(18)
  })

  it('기업마당 분야 순서를 유지하고 K-Startup 공식 분야를 중복 없이 바로 제공한다', () => {
    expect(defaultCatalogCategories).toEqual([
      '경영', '금융', '기술', '기타', '내수', '수출', '인력', '창업',
      '글로벌', '기술개발(R&D)', '멘토링ㆍ컨설팅ㆍ교육', '사업화', '시설ㆍ공간ㆍ보육',
      '융자ㆍ보증', '정책자금', '창업교육', '판로ㆍ해외진출', '행사ㆍ네트워크',
    ])
    expect(defaultCatalogCategories).toHaveLength(18)
    expect(new Set(defaultCatalogCategories).size).toBe(defaultCatalogCategories.length)
  })
})

describe('mergeCatalogFilterOptions', () => {
  it('서버 응답이 없어도 전체 기본 목록을 제공한다', () => {
    expect(mergeCatalogFilterOptions(defaultCatalogRegions)).toEqual(defaultCatalogRegions)
    expect(mergeCatalogFilterOptions(defaultCatalogCategories)).toEqual(defaultCatalogCategories)
  })

  it.each([
    { name: '빈 배열', available: [] },
    { name: '일부 분야', available: ['수출'] },
    { name: '서로 다른 순서의 일부 분야', available: ['창업', '금융', '경영'] },
  ])('서버가 $name만 반환해도 기본 분야와 순서를 유지한다', ({ available }) => {
    expect(mergeCatalogFilterOptions(defaultCatalogCategories, available)).toEqual(defaultCatalogCategories)
  })

  it('기본값과 서버값의 중복을 제거하고 서버 추가값은 받은 순서대로 뒤에 붙인다', () => {
    expect(mergeCatalogFilterOptions(defaultCatalogCategories, ['AI', '수출', 'AI', '디지털 전환', '기술', '디지털 전환']))
      .toEqual([...defaultCatalogCategories, 'AI', '디지털 전환'])
    expect(mergeCatalogFilterOptions(['서울', '서울', '전국'], ['전국', '서울특별시', '서울특별시']))
      .toEqual(['서울', '전국', '서울특별시'])
  })

  it('서버가 정규값과 별도 지역 태그를 반환해도 명칭을 합치거나 기본 순서를 바꾸지 않는다', () => {
    expect(mergeCatalogFilterOptions(defaultCatalogRegions, ['서울특별시', '충북', '서울', '강원']))
      .toEqual([...defaultCatalogRegions, '서울특별시'])
  })

  it('빈 값만 제외하고 유효한 문자열의 공백이나 명칭은 정규화하지 않는다', () => {
    expect(mergeCatalogFilterOptions(['서울', '', '  '], ['', ' ', '\t\n', ' 서울 ', '서울특별시', '서울']))
      .toEqual(['서울', ' 서울 ', '서울특별시'])
    expect(mergeCatalogFilterOptions(defaultCatalogCategories, [' AI ', 'AI']))
      .toEqual([...defaultCatalogCategories, ' AI ', 'AI'])
  })

  it('읽기 전용 원본 배열을 변경하지 않고 독립적인 결과 배열을 반환한다', () => {
    const defaults = Object.freeze(['서울', '전국'])
    const available = Object.freeze(['서울특별시', '서울', '서울특별시'])
    const merged = mergeCatalogFilterOptions(defaults, available)

    expect(merged).toEqual(['서울', '전국', '서울특별시'])
    merged.push('부산')
    expect(defaults).toEqual(['서울', '전국'])
    expect(available).toEqual(['서울특별시', '서울', '서울특별시'])
  })
})
