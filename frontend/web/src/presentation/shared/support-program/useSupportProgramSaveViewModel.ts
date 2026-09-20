import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { appContainer } from '../../../app/appContainer'
import { useAppSelector } from '../../../app/hooks'
import type { SupportProgramIdentity } from '../../../domain/repositories/SupportProgramRepository'
import type {
  CheckSavedSupportProgramUseCase,
  RemoveSavedSupportProgramUseCase,
  SaveSupportProgramUseCase,
} from '../../../domain/usecases/SavedSupportProgramUseCases'
import { loginPathFor } from '../auth/returnPath'
import { selectIsAuthenticated } from '../auth/state/authSlice'
import { appPaths } from '../routes/appPaths'

type SaveUseCases = {
  check: Pick<CheckSavedSupportProgramUseCase, 'execute'>
  save: Pick<SaveSupportProgramUseCase, 'execute'>
  remove: Pick<RemoveSavedSupportProgramUseCase, 'execute'>
}

/**
 * 담기·빼기 안내가 스스로 사라지기까지의 시간입니다. 짧은 확인 문구는 3~5초가 권장 범위(WCAG 2.2.1 예외인
 * 5초 미만·Material 4~10초)라 4초로 두고, 그 전에 닫을 수도 있습니다.
 */
export const supportProgramSaveNoticeDurationMs = 4_000

export type SupportProgramSaveNotice = { id: number; text: string }

export const supportProgramSaveMessages = {
  saved: '관심 공고함에 담았습니다.',
  removed: '관심 공고함에서 뺐습니다.',
  notFound: '더 이상 제공되지 않는 공고라 담을 수 없습니다.',
  failed: '관심 공고 저장을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

/**
 * 공고 상세·모집글 상세의 관심 공고 저장 버튼 ViewModel입니다. 로그인한 회원만 담긴 여부를 확인하고 담기·빼기를 오가며,
 * 비로그인이면 요청 없이 로그인 뒤 이 공고로 돌아오는 경로만 만듭니다.
 */
export function useSupportProgramSaveViewModel(identity: SupportProgramIdentity, useCases?: Partial<SaveUseCases>) {
  const resolved: SaveUseCases = {
    check: useCases?.check ?? appContainer.resolve('checkSavedSupportProgramUseCase'),
    save: useCases?.save ?? appContainer.resolve('saveSupportProgramUseCase'),
    remove: useCases?.remove ?? appContainer.resolve('removeSavedSupportProgramUseCase'),
  }
  const isAuthenticated = useAppSelector(selectIsAuthenticated)
  const { pathname, search } = useLocation()
  const { sourceCode, sourceProgramId } = identity
  const [isSaved, setIsSaved] = useState<boolean | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [notice, setNoticeState] = useState<SupportProgramSaveNotice | null>(null)
  const noticeSequence = useRef(0)
  const setNotice = (text: string | null) => {
    noticeSequence.current += 1
    setNoticeState(text === null ? null : { id: noticeSequence.current, text })
  }

  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNoticeState(null), supportProgramSaveNoticeDurationMs)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!isAuthenticated) return
    const controller = new AbortController()
    setIsSaved(null)
    setNotice(null)
    resolved.check.execute({ sourceCode, sourceProgramId }, controller.signal)
      .then((saved) => { if (!controller.signal.aborted) setIsSaved(saved) })
      // 확인에 실패해도 버튼은 두고, 누르면 담기를 시도합니다.
      .catch(() => { if (!controller.signal.aborted) setIsSaved(false) })
    return () => controller.abort()
    // UseCase는 앱 수명 동안 같으므로 공고가 바뀔 때만 다시 확인합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, sourceCode, sourceProgramId])

  async function toggle() {
    if (isBusy || !isAuthenticated) return
    setIsBusy(true)
    setNotice(null)
    try {
      if (isSaved) {
        await resolved.remove.execute({ sourceCode, sourceProgramId })
        setIsSaved(false)
        setNotice(supportProgramSaveMessages.removed)
        return
      }
      const result = await resolved.save.execute({ sourceCode, sourceProgramId })
      if (result.outcome === 'not-found') {
        setNotice(supportProgramSaveMessages.notFound)
        return
      }
      setIsSaved(true)
      setNotice(supportProgramSaveMessages.saved)
    } catch {
      setNotice(supportProgramSaveMessages.failed)
    } finally {
      setIsBusy(false)
    }
  }

  return {
    isAuthenticated,
    /** null이면 아직 확인 전입니다. */
    isSaved,
    isBusy,
    /** 담기·빼기 결과입니다. [supportProgramSaveNoticeDurationMs] 뒤 스스로 사라집니다. */
    notice,
    dismissNotice: () => setNotice(null),
    toggle,
    savedProgramsPath: appPaths.savedPrograms,
    /** 로그인 뒤 같은 공고 상세로 돌아옵니다. */
    loginPath: loginPathFor(`${pathname}${search}`),
  }
}
