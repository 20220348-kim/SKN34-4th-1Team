import { describe, expect, it, vi } from 'vitest'

import type { SampleItem } from '../entities/SampleItem'
import type { SampleItemPreparation } from '../entities/SampleItemPreparation'
import type { SampleItemRepository } from '../repositories/SampleItemRepository'
import { PrepareSampleItemUseCase } from './PrepareSampleItemUseCase'

describe('PrepareSampleItemUseCase', () => {
  it('injects the repository once and executes with only the sample item', async () => {
    const item: SampleItem = {
      category: null,
      name: '예제',
      note: null,
    }
    const preparation: SampleItemPreparation = {
      item,
      phase: 'READY_FOR_PROCESSING',
      processing: { status: 'NOT_STARTED' },
    }
    const prepare = vi.fn().mockResolvedValue(preparation)
    const repository: SampleItemRepository = { prepare }
    const useCase = new PrepareSampleItemUseCase(repository)
    const controller = new AbortController()

    await expect(useCase.execute(item, controller.signal)).resolves.toEqual(preparation)
    expect(prepare).toHaveBeenCalledWith(item, controller.signal)
  })
})
