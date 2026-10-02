import { toSupportProgram } from '@govbiz/shared/data/models/SupportProgramDto'
import { SupportProgramSearchRestoreApiError } from '@govbiz/shared/data/api/supportProgramApi'
import { SupportProgramSearchRestoreError } from '@govbiz/shared/domain/errors/SupportProgramSearchRestoreError'
import type { RestoredSupportProgramSearchResult, SupportProgramSearchResult } from '@govbiz/shared/domain/entities/SupportProgramSearchResult'
import type { SupportProgramSearch } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, programClient } from './client'

/** HTTP DTO conversion stays at the mobile API boundary, outside screen state. */
export async function searchPrograms(token: string | undefined, command: SupportProgramSearch, signal?: AbortSignal): Promise<SupportProgramSearchResult> {
  const response = await programClient(token).search(command, signal)
  return { ...response, programs: response.programs.map(toSupportProgram) }
}

export async function restoreSearchResults(token: string, resultToken: string, signal?: AbortSignal): Promise<RestoredSupportProgramSearchResult> {
  try {
    const response = await programClient(token).restoreSearch(resultToken, signal)
    return { ...response, programs: response.programs.map(toSupportProgram), context: {
      ...response.context, companyConditions: { ...response.context.companyConditions },
    } }
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new SupportProgramSearchRestoreError(cause instanceof ApiError && cause.status === 401 ? 'unauthorized'
      : cause instanceof SupportProgramSearchRestoreApiError ? cause.reason : 'unavailable')
  }
}
