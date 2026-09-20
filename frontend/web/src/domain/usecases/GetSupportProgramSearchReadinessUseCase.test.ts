import { describe, expect, it, vi } from 'vitest'

import { GetSupportProgramSearchReadinessUseCase } from './GetSupportProgramSearchReadinessUseCase'

describe('GetSupportProgramSearchReadinessUseCase', () => {
  it('passes the cancellation signal to the readiness repository', async () => {
    const readiness = {
      searchState: 'SEARCHABLE' as const,
      programCount: 12,
      indexReady: true,
      lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00',
      lastFailedSyncAt: null,
      sources: [{
        sourceCode: 'BIZINFO', sourceName: '기업마당', searchState: 'SEARCHABLE' as const,
        programCount: 12, indexReady: true,
        lastSuccessfulSyncAt: '2026-09-05T09:00:00+09:00', lastFailedSyncAt: null,
      }],
    }
    const getSearchReadiness = vi.fn().mockResolvedValue(readiness)
    const useCase = new GetSupportProgramSearchReadinessUseCase({ getSearchReadiness })
    const controller = new AbortController()

    await expect(useCase.execute(controller.signal)).resolves.toEqual(readiness)
    expect(getSearchReadiness).toHaveBeenCalledWith(controller.signal)
  })
})
