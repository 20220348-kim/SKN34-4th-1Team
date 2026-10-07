import { describe, expect, it, vi } from 'vitest'
import { createSupportProgramClient } from '../../data/api/supportProgramClient'
import type { SupportProgramCatalogFilters } from '../entities/SupportProgramCatalog'
import { defaultCatalogCategories, defaultCatalogRegions } from '../entities/SupportProgramCatalogFilterOptions'
import { BrowseSupportProgramsUseCase } from './BrowseSupportProgramsUseCase'

const filters: SupportProgramCatalogFilters = {
  keyword: '', region: '', category: '', sourceCode: '', startupStage: '', applicantType: '', founderAge: '',
  status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
}
const emptyCatalog = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0,
  regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }

describe('다중 공고 필터의 기존 Core 길이 계약', () => {
  it('전체 지역과 추가 분야를 검증한 뒤 쉼표 조건 그대로 HTTP 요청에 전달한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(emptyCatalog))
    const client = createSupportProgramClient({ baseUrl: 'https://api.example.test', fetch: fetchMock })
    const useCase = new BrowseSupportProgramsUseCase(client)
    const region = defaultCatalogRegions.join(',')
    const category = [...defaultCatalogCategories, '제공처 추가 분야', '별도 분야'].join(',')
    expect(region.length).toBeGreaterThan(50)
    expect(category.length).toBeGreaterThan(100)
    const signal = new AbortController().signal
    await expect(useCase.execute({ ...filters, region, category }, signal)).resolves.toEqual(emptyCatalog)
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('region')).toBe(region)
    expect(url.searchParams.get('category')).toBe(category)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([['region', 200], ['category', 300]] as const)('%s는 Core 최대 길이 %i자를 허용한다', async (field, length) => {
    const browseCatalog = vi.fn().mockResolvedValue(emptyCatalog)
    await new BrowseSupportProgramsUseCase({ browseCatalog }).execute({ ...filters, [field]: '가'.repeat(length) })
    expect(browseCatalog).toHaveBeenCalledWith({ ...filters, [field]: '가'.repeat(length) }, undefined)
  })

  it.each([
    { region: '가'.repeat(201) }, { category: '가'.repeat(301) }, { keyword: '가'.repeat(101) },
    { region: '서울,경기\u200b' }, { category: '경영,금융\u0000' },
    { sourceCode: 'KSTARTUP', startupStage: '가'.repeat(101) },
  ])('길이 초과와 제어 문자는 HTTP 호출 전에 거부한다 %j', invalid => {
    const browseCatalog = vi.fn()
    expect(() => new BrowseSupportProgramsUseCase({ browseCatalog })
      .execute({ ...filters, ...invalid } as SupportProgramCatalogFilters)).toThrow('공고 검색 조건을 확인해 주세요.')
    expect(browseCatalog).not.toHaveBeenCalled()
  })
})
