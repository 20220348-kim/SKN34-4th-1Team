import type { SavedSupportProgram } from '../../domain/entities/SavedSupportProgram'
import type { SavedSupportProgramRepository, SaveSupportProgramResult } from '../../domain/repositories/SavedSupportProgramRepository'
import type { SupportProgramIdentity } from '../../domain/repositories/SupportProgramRepository'
import { AccountApiError } from '../api/accountApi'
import {
  getSavedSupportProgramStatusApi,
  listSavedSupportProgramsApi,
  removeSavedSupportProgramApi,
  saveSupportProgramApi,
} from '../api/savedSupportProgramApi'
import { toSavedSupportProgram } from '../models/SavedSupportProgramDto'

/** Core API 관심 공고함 DTO를 Domain 값으로 바꾸고, 없는 공고(404)는 결과로 돌려주는 adapter입니다. */
export class SavedSupportProgramRepositoryImpl implements SavedSupportProgramRepository {
  async list(signal?: AbortSignal): Promise<SavedSupportProgram[]> {
    return (await listSavedSupportProgramsApi(signal)).map(toSavedSupportProgram)
  }

  isSaved(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<boolean> {
    return getSavedSupportProgramStatusApi(identity, signal)
  }

  async save(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SaveSupportProgramResult> {
    try {
      return { outcome: 'saved', saved: toSavedSupportProgram(await saveSupportProgramApi(identity, signal)) }
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404 && error.code === 'SUPPORT_PROGRAM_NOT_FOUND') return { outcome: 'not-found' }
      throw error
    }
  }

  remove(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<void> {
    return removeSavedSupportProgramApi(identity, signal)
  }
}
