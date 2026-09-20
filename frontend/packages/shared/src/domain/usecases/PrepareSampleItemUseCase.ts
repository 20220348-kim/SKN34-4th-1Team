import type { SampleItem } from '../entities/SampleItem'
import type { SampleItemPreparation } from '../entities/SampleItemPreparation'
import type { SampleItemRepository } from '../repositories/SampleItemRepository'

/** Repository는 생성할 때 주입하고, 실행할 때는 처리할 항목만 받습니다. */
export class PrepareSampleItemUseCase {
  private readonly repository: SampleItemRepository

  constructor(repository: SampleItemRepository) {
    this.repository = repository
  }

  execute(item: SampleItem, signal?: AbortSignal): Promise<SampleItemPreparation> {
    return this.repository.prepare(item, signal)
  }
}
