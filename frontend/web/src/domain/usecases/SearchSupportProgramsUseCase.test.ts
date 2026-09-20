import { completeSearchResult } from '../../data/fixtures/supportProgramSearchResult'
import { describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../data/fixtures/supportPrograms'
import { SearchSupportProgramsUseCase } from './SearchSupportProgramsUseCase'

describe('SearchSupportProgramsUseCase', () => {
  it('returns the repository result without client-side reranking', async () => {
    const rankedPrograms = [supportPrograms[3], supportPrograms[0]]
    const search = vi.fn().mockResolvedValue(completeSearchResult({ query: '수출을 준비하는 서울 기업', programs: rankedPrograms }))
    const useCase = new SearchSupportProgramsUseCase({ search })

    const result = await useCase.execute({ query: '수출을 준비하는 서울 기업' })

    expect(result.programs).toEqual(rankedPrograms)
  })

  it('normalizes the query and forwards request cancellation', async () => {
    const search = vi.fn().mockResolvedValue(completeSearchResult({ query: '서울 AI', programs: [] }))
    const controller = new AbortController()
    const cancellableUseCase = new SearchSupportProgramsUseCase({ search })

    await cancellableUseCase.execute({ query: '  서울 AI  ' }, controller.signal)

    expect(search).toHaveBeenCalledWith(
      { acceptingOnly: true, query: '서울 AI' },
      controller.signal,
    )
  })

  it('passes confirmed company conditions separately from the unchanged search query', async () => {
    const search = vi.fn().mockResolvedValue(completeSearchResult({ query: '서울 지원금', programs: [] }))
    const useCase = new SearchSupportProgramsUseCase({ search })
    const companyConditions = { region: '부산', industry: '소프트웨어', establishedOn: '2024-03-01', supportPurpose: '사업화' }
    await useCase.execute({ query: '서울 지원금', acceptingOnly: false, companyConditions })
    expect(search).toHaveBeenCalledWith({ query: '서울 지원금', acceptingOnly: false, companyConditions }, undefined)
  })
})
