import type { SupportProgramSearchResult } from '../entities/SupportProgramSearchResult'
import type { SupportProgramRepository, SupportProgramSearch } from '../repositories/SupportProgramRepository'

type SupportProgramSearchRepository = Pick<SupportProgramRepository, 'search'>

export type SearchSupportProgramsResult = SupportProgramSearchResult

export class SearchSupportProgramsUseCase {
  private readonly repository: SupportProgramSearchRepository

  constructor(repository: SupportProgramSearchRepository) {
    this.repository = repository
  }

  async execute(command: SupportProgramSearch, signal?: AbortSignal): Promise<SearchSupportProgramsResult> {
    const normalizedQuery = command.query.trim()
    return this.repository.search(
      { ...command, query: normalizedQuery, acceptingOnly: command.acceptingOnly ?? true },
      signal,
    )
  }
}
