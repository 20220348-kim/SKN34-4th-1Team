import { describe, expect, it, vi } from 'vitest'

import type { SupportProgramCatalogFilters } from '../entities/SupportProgramCatalog'
import { BrowseSupportProgramsUseCase } from './BrowseSupportProgramsUseCase'

const filters: SupportProgramCatalogFilters = { keyword: '', region: '', category: '', status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
  sourceCode: '', startupStage: '', applicantType: '', founderAge: '' }
describe('BrowseSupportProgramsUseCase', () => {
  it.each(['MSIT', 'CNTRADE_NOTICE'] as const)('%s의 접수 상태를 자동 변경하지 않고 전달하며 K-Startup 전용 조건은 거부한다', async (sourceCode) => {
    const browseCatalog = vi.fn().mockResolvedValue({ total: 0 })
    const useCase = new BrowseSupportProgramsUseCase({ browseCatalog })
    for (const status of ['OPEN', 'ALL', 'UNKNOWN'] as const) {
      await useCase.execute({ ...filters, sourceCode, status })
      expect(browseCatalog).toHaveBeenLastCalledWith({ ...filters, sourceCode, status }, undefined)
    }
    for (const field of ['startupStage', 'applicantType', 'founderAge'] as const) {
      expect(() => useCase.execute({ ...filters, sourceCode, [field]: '조건' })).toThrow('공고 검색 조건을 확인해 주세요.')
    }
    expect(browseCatalog).toHaveBeenCalledTimes(3)
  })

  it('K-Startup 추가 조건을 정규화하며 공식 문자열을 임의로 바꾸지 않는다', async () => {
    const browseCatalog = vi.fn().mockResolvedValue({ total: 0 })
    await new BrowseSupportProgramsUseCase({ browseCatalog }).execute({ ...filters, sourceCode: 'KSTARTUP',
      startupStage: ' 3년미만 ', applicantType: ' 1인 창조기업 ', founderAge: ' 만 20세 이상 ~ 만 39세 이하 ' })
    expect(browseCatalog).toHaveBeenCalledWith({ ...filters, sourceCode: 'KSTARTUP',
      startupStage: '3년미만', applicantType: '1인 창조기업', founderAge: '만 20세 이상 ~ 만 39세 이하' }, undefined)
  })

  it.each([
    { sourceCode: 'UNKNOWN' }, { startupStage: '예비창업자' },
    { sourceCode: 'BIZINFO', applicantType: '일반기업' }, { founderAge: '만 40세 이상' },
    { sourceCode: 'KSTARTUP', startupStage: '가'.repeat(101) },
    { sourceCode: 'KSTARTUP', applicantType: '일반인\u0000' },
  ])('출처에 맞지 않거나 잘못된 추가 조건은 요청 전에 거부한다 %j', (invalid) => {
    const browseCatalog = vi.fn()
    expect(() => new BrowseSupportProgramsUseCase({ browseCatalog })
      .execute({ ...filters, ...invalid } as SupportProgramCatalogFilters)).toThrow()
    expect(browseCatalog).not.toHaveBeenCalled()
  })

  it('빈 키워드도 허용하고 필터를 정규화해 전달한다', async () => {
    const browseCatalog = vi.fn().mockResolvedValue({ total: 0 })
    const signal = new AbortController().signal
    await new BrowseSupportProgramsUseCase({ browseCatalog }).execute({ ...filters, keyword: '  ', region: ' 서울 ' }, signal)
    expect(browseCatalog).toHaveBeenCalledWith({ ...filters, region: '서울' }, signal)
  })
  it.each([{ page: 0 }, { page: 1.5 }, { page: 1_000_001 }, { pageSize: 51 }, { keyword: '가'.repeat(101) }, { keyword: 'abc\u0000' }])(
    '잘못된 입력은 요청 전에 거부한다 %j', (invalid) => {
      const browseCatalog = vi.fn()
      expect(() => new BrowseSupportProgramsUseCase({ browseCatalog }).execute({ ...filters, ...invalid })).toThrow()
      expect(browseCatalog).not.toHaveBeenCalled()
    },
  )
})
