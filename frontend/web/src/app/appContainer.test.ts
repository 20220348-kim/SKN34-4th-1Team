import { completeSearchResult } from '../data/fixtures/supportProgramSearchResult'
import { asValue } from 'awilix/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../data/fixtures/supportPrograms'
import type { SampleItem } from '../domain/entities/SampleItem'
import type { SampleItemRepository } from '../domain/repositories/SampleItemRepository'
import type { SupportProgramRepository } from '../domain/repositories/SupportProgramRepository'
import { AskSupportProgramEvidenceQuestionUseCase } from '../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import { GetSupportProgramDetailUseCase } from '../domain/usecases/GetSupportProgramDetailUseCase'
import { GetSupportProgramSearchReadinessUseCase } from '../domain/usecases/GetSupportProgramSearchReadinessUseCase'
import { PrepareSampleItemUseCase } from '../domain/usecases/PrepareSampleItemUseCase'
import { SearchSupportProgramsUseCase } from '../domain/usecases/SearchSupportProgramsUseCase'
import { appContainer } from './appContainer'
import { createAppContainer } from './di/container'

describe('Awilix application container and Service Locator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the same UseCase singletons from the global Service Locator', () => {
    const evidenceQuestionUseCase = appContainer.resolve('askSupportProgramEvidenceQuestionUseCase')
    const prepareUseCase = appContainer.resolve('prepareSampleItemUseCase')
    const detailUseCase = appContainer.resolve('getSupportProgramDetailUseCase')
    const readinessUseCase = appContainer.resolve('getSupportProgramSearchReadinessUseCase')
    const searchUseCase = appContainer.resolve('searchSupportProgramsUseCase')

    expect(evidenceQuestionUseCase).toBeInstanceOf(AskSupportProgramEvidenceQuestionUseCase)
    expect(prepareUseCase).toBeInstanceOf(PrepareSampleItemUseCase)
    expect(detailUseCase).toBeInstanceOf(GetSupportProgramDetailUseCase)
    expect(readinessUseCase).toBeInstanceOf(GetSupportProgramSearchReadinessUseCase)
    expect(searchUseCase).toBeInstanceOf(SearchSupportProgramsUseCase)
    expect(appContainer.resolve('askSupportProgramEvidenceQuestionUseCase')).toBe(evidenceQuestionUseCase)
    expect(appContainer.resolve('getSupportProgramDetailUseCase')).toBe(detailUseCase)
    expect(appContainer.resolve('getSupportProgramSearchReadinessUseCase')).toBe(readinessUseCase)
    expect(appContainer.resolve('prepareSampleItemUseCase')).toBe(prepareUseCase)
    expect(appContainer.resolve('searchSupportProgramsUseCase')).toBe(
      searchUseCase,
    )
  })

  it('resolves the production graph and executes the Core API search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(completeSearchResult({
      query: '서울 AI',
      programs: [supportPrograms[0]],
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const container = createAppContainer()
    const result = await container
      .resolve('searchSupportProgramsUseCase')
      .execute({ query: '서울 AI' })

    expect(result.query).toBe('서울 AI')
    expect(result.programs[0]?.id).toBe('fixture-seoul-ai-business')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reuses singletons inside one container and isolates fresh containers', () => {
    const first = createAppContainer()
    const second = createAppContainer()

    expect(first.resolve('prepareSampleItemUseCase')).toBe(
      first.resolve('prepareSampleItemUseCase'),
    )
    expect(first.resolve('supportProgramRepository')).toBe(
      first.resolve('supportProgramRepository'),
    )
    expect(first.resolve('getSupportProgramDetailUseCase')).toBe(
      first.resolve('getSupportProgramDetailUseCase'),
    )
    expect(first.resolve('prepareSampleItemUseCase')).not.toBe(
      second.resolve('prepareSampleItemUseCase'),
    )
    expect(first.resolve('searchSupportProgramsUseCase')).not.toBe(
      second.resolve('searchSupportProgramsUseCase'),
    )
  })

  it('injects a repository override into the real search use case', async () => {
    const search = vi.fn().mockResolvedValue(completeSearchResult({ query: '수출', programs: [supportPrograms[3]] }))
    const repository: SupportProgramRepository = {
      browseCatalog: vi.fn(),
      interpretConversation: vi.fn(),
      answerEvidenceQuestion: vi.fn(),
      getDetail: vi.fn(),
      getSearchReadiness: vi.fn(),
      search,
      restoreSearch: vi.fn(),
    }
    const container = createAppContainer()
    container.register({ supportProgramRepository: asValue(repository) })

    const result = await container
      .resolve('searchSupportProgramsUseCase')
      .execute({ query: '수출' })

    expect(search).toHaveBeenCalledWith(
      { acceptingOnly: true, query: '수출' },
      undefined,
    )
    expect(result.programs).toEqual([supportPrograms[3]])
  })

  it('injects the sample repository and executes with one item argument', async () => {
    const item: SampleItem = { category: null, name: '예제', note: null }
    const preparation = {
      item,
      phase: 'READY_FOR_PROCESSING' as const,
      processing: { status: 'NOT_STARTED' as const },
    }
    const prepare = vi.fn().mockResolvedValue(preparation)
    const repository: SampleItemRepository = { prepare }
    const container = createAppContainer()
    container.register({ sampleItemRepository: asValue(repository) })
    const controller = new AbortController()

    const result = await container
      .resolve('prepareSampleItemUseCase')
      .execute(item, controller.signal)

    expect(prepare).toHaveBeenCalledWith(item, controller.signal)
    expect(result).toEqual(preparation)
  })
})
