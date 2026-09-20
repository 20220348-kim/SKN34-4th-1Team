import type { SavedSupportProgram } from '../entities/SavedSupportProgram'
import type { SupportProgramIdentity } from './SupportProgramRepository'

/** 없거나 더 이상 노출되지 않는 공고는 담을 수 없습니다. */
export type SaveSupportProgramResult =
  | { outcome: 'saved'; saved: SavedSupportProgram }
  | { outcome: 'not-found' }

/** 로그인한 회원의 관심 공고함입니다. 모두 세션 쿠키로 인증합니다. */
export interface SavedSupportProgramRepository {
  /** 최근에 담은 순서입니다. 더 이상 노출되지 않는 공고는 빠집니다. */
  list(signal?: AbortSignal): Promise<SavedSupportProgram[]>
  isSaved(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<boolean>
  /** 이미 담긴 공고를 다시 담아도 `saved`입니다. */
  save(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<SaveSupportProgramResult>
  /** 담기지 않은 공고를 빼도 성공입니다. */
  remove(identity: SupportProgramIdentity, signal?: AbortSignal): Promise<void>
}
