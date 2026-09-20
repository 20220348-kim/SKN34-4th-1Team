import { useCallback, useEffect, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramIdentity } from '../../../../domain/repositories/SupportProgramRepository'
import type { GetSupportProgramDetailUseCase } from '../../../../domain/usecases/GetSupportProgramDetailUseCase'

type SupportProgramDetailUseCase = Pick<GetSupportProgramDetailUseCase, 'execute'>

/** DB 상세 조회가 응답하지 않아 화면이 무기한 로딩되는 것을 막습니다. */
export const supportProgramDetailTimeoutMilliseconds = 10_000

export type SupportProgramDetailLoadState =
  | { status: 'loading'; program: null }
  | { status: 'ready'; program: SupportProgram }
  | { status: 'not-found'; program: null }
  | { status: 'failed'; program: null }

/** URL의 원본 식별자가 바뀔 때마다 상세 API를 조회하고 화면 상태로 변환합니다. */
export function useSupportProgramDetailViewModel(
  identity: SupportProgramIdentity,
  getSupportProgramDetailUseCase: SupportProgramDetailUseCase = appContainer.resolve(
    'getSupportProgramDetailUseCase',
  ),
): SupportProgramDetailLoadState & { retry: () => void } {
  const { sourceCode, sourceProgramId } = identity
  const [requestVersion, setRequestVersion] = useState(0)
  const retry = useCallback(() => setRequestVersion((version) => version + 1), [])
  const [state, setState] = useState<SupportProgramDetailLoadState>({
    status: 'loading',
    program: null,
  })

  useEffect(() => {
    const controller = new AbortController()
    let isCurrentRequest = true

    setState({ status: 'loading', program: null })
    const timeoutId = setTimeout(() => {
      if (!isCurrentRequest) return
      controller.abort()
      setState({ status: 'failed', program: null })
    }, supportProgramDetailTimeoutMilliseconds)

    void getSupportProgramDetailUseCase
      .execute({ sourceCode, sourceProgramId }, controller.signal)
      .then((program) => {
        if (!isCurrentRequest || controller.signal.aborted) return
        setState(program
          ? { status: 'ready', program }
          : { status: 'not-found', program: null })
      })
      .catch(() => {
        if (!isCurrentRequest || controller.signal.aborted) return

        setState({
          status: 'failed',
          program: null,
        })
      })
      .finally(() => clearTimeout(timeoutId))

    return () => {
      isCurrentRequest = false
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [
    getSupportProgramDetailUseCase,
    requestVersion,
    sourceCode,
    sourceProgramId,
  ])

  return { ...state, retry }
}
