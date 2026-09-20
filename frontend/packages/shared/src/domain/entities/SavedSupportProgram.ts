import type { SupportProgram } from './SupportProgram'

/** 관심 공고함에 담은 공고 하나입니다. [program]은 담을 때가 아니라 조회 시점의 현재 공고 내용입니다. */
export type SavedSupportProgram = {
  /** 담은 시각(서울 기준 ISO 로컬 시각)입니다. */
  savedAt: string
  program: SupportProgram
}
