import type { SavedSupportProgram } from '../entities/SavedSupportProgram'
import type { SavedSupportProgramRepository, SaveSupportProgramResult } from '../repositories/SavedSupportProgramRepository'
import type { SupportProgramIdentity } from '../repositories/SupportProgramRepository'

/** 제공처 코드와 원본 ID가 비어 있으면 서버에 묻지 않습니다. */
function requireIdentity(identity: SupportProgramIdentity): SupportProgramIdentity {
  if (identity.sourceCode.trim() === '' || identity.sourceProgramId.trim() === '') {
    throw new RangeError('support program identity must not be blank')
  }
  return identity
}

/** 관심 공고함 목록을 최근에 담은 순서로 읽습니다. */
export class BrowseSavedSupportProgramsUseCase {
  private readonly repository: Pick<SavedSupportProgramRepository, 'list'>

  constructor(repository: Pick<SavedSupportProgramRepository, 'list'>) {
    this.repository = repository
  }

  execute(signal?: AbortSignal): Promise<SavedSupportProgram[]> {
    return this.repository.list(signal)
  }
}

/** 공고 상세가 담기 버튼 상태를 그리기 위해 담겨 있는지 확인합니다. */
export class CheckSavedSupportProgramUseCase {
  private readonly repository: Pick<SavedSupportProgramRepository, 'isSaved'>

  constructor(repository: Pick<SavedSupportProgramRepository, 'isSaved'>) {
    this.repository = repository
  }

  execute(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<boolean> {
    return this.repository.isSaved(requireIdentity(identity), signal)
  }
}

/** 공고를 관심 공고함에 담습니다. */
export class SaveSupportProgramUseCase {
  private readonly repository: Pick<SavedSupportProgramRepository, 'save'>

  constructor(repository: Pick<SavedSupportProgramRepository, 'save'>) {
    this.repository = repository
  }

  execute(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SaveSupportProgramResult> {
    return this.repository.save(requireIdentity(identity), signal)
  }
}

/** 관심 공고함에서 공고를 뺍니다. */
export class RemoveSavedSupportProgramUseCase {
  private readonly repository: Pick<SavedSupportProgramRepository, 'remove'>

  constructor(repository: Pick<SavedSupportProgramRepository, 'remove'>) {
    this.repository = repository
  }

  execute(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<void> {
    return this.repository.remove(requireIdentity(identity), signal)
  }
}
