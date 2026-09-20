import { useEffect, useState } from 'react'

import { appContainer } from '../../../app/appContainer'
import type { SupportProgram } from '../../../domain/entities/SupportProgram'
import type { BrowseSavedSupportProgramsUseCase } from '../../../domain/usecases/SavedSupportProgramUseCases'

type SavedProgramChoiceState =
  | { phase: 'idle' | 'loading'; programs: SupportProgram[] }
  | { phase: 'ready'; programs: SupportProgram[] }
  | { phase: 'failed'; programs: SupportProgram[] }

/** 공고를 고르는 여러 작업 화면에서 로그인 회원의 관심 공고를 같은 방식으로 불러옵니다. */
export function useSavedSupportProgramChoices(
  enabled = true,
  useCase: Pick<BrowseSavedSupportProgramsUseCase, 'execute'> = appContainer.resolve('browseSavedSupportProgramsUseCase'),
) {
  const [state, setState] = useState<SavedProgramChoiceState>({ phase: 'idle', programs: [] })
  const [loadVersion, setLoadVersion] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setState({ phase: 'idle', programs: [] })
      return
    }
    const controller = new AbortController()
    setState((current) => ({ phase: 'loading', programs: current.programs }))
    useCase.execute(controller.signal)
      .then((saved) => {
        if (!controller.signal.aborted) setState({ phase: 'ready', programs: saved.map(({ program }) => program) })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ phase: 'failed', programs: current.programs }))
      })
    return () => controller.abort()
  }, [enabled, loadVersion, useCase])

  return { ...state, retry: () => setLoadVersion((current) => current + 1) }
}
