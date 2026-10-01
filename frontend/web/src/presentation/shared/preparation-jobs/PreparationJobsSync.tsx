import { useEffect, useRef } from 'react'

import { appContainer } from '../../../app/appContainer'
import { useAppDispatch, useAppSelector } from '../../../app/hooks'
import { useAuthSession } from '../auth/hooks/useAuthSession'
import {
  preparationJobsLoaded,
  selectPreparationAnalysisJobs,
  selectPreparationDocumentJobs,
  selectPreparationJobsRefreshToken,
} from './state/preparationJobsSlice'
import { preparationJobPollMs, preparationJobsPollMs } from './usePreparationJobs'

/** 기다릴 작업이 없을 때 읽기에 실패하면 이만큼만 다시 읽습니다. 그 뒤로는 화면이 새로 읽기를 요청할 때까지 기다립니다. */
const maxIdleRetries = 3
/** 주기적으로 읽는 중에 이만큼 연달아 실패하면 읽기를 멈춥니다(세션 만료 · 서버 중단에서 요청이 끝없이 나가지 않게). */
const maxPollingFailures = 12

/**
 * 계정의 최근 양식 분석 · 문서 생성 작업을 읽어 Redux에 둡니다(GET · AI 호출 없음). 작업 화면 틀에 한 번만 두며 아무것도 그리지 않습니다.
 * 진행 중인 작업이 있으면 끝날 때까지, 결과 확인 중인 작업만 남으면 느리게 다시 읽고, 화면이 새로 읽기를 요청하면 바로 읽습니다.
 * 못 읽어도 화면은 그대로 쓸 수 있으므로 실패는 알리지 않습니다. 대신 몇 번 다시 읽고, 계속 실패하면 다음 요청 때까지 멈춥니다.
 */
export function PreparationJobsSync() {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const dispatch = useAppDispatch()
  const { account } = useAuthSession()
  const accountEmail = account?.email ?? null
  const analysisJobs = useAppSelector(selectPreparationAnalysisJobs)
  const documentJobs = useAppSelector(selectPreparationDocumentJobs)
  const refreshToken = useAppSelector(selectPreparationJobsRefreshToken)
  const handledToken = useRef<number | null>(null)
  /** 연달아 실패한 횟수입니다. any는 둘 중 하나라도, all은 둘 다 못 읽은 횟수입니다. */
  const failures = useRef({ any: 0, all: 0 })
  const pollMs = preparationJobsPollMs([...analysisJobs, ...documentJobs])

  useEffect(() => {
    if (accountEmail === null) return
    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const load = () => Promise.all([
      useCase.discoveryJobs(controller.signal).catch(() => null),
      useCase.recentDocumentJobs(controller.signal).catch(() => null),
    ]).then(([analyses, documents]) => {
      if (controller.signal.aborted) return
      const anyFailed = analyses === null || documents === null
      const allFailed = analyses === null && documents === null
      failures.current = { any: anyFailed ? failures.current.any + 1 : 0, all: allFailed ? failures.current.all + 1 : 0 }
      if (!allFailed) dispatch(preparationJobsLoaded({ accountEmail, analysisJobs: analyses, documentJobs: documents, readAt: Date.now() }))
      if (anyFailed && pollMs === null && failures.current.any <= maxIdleRetries) retryTimer = setTimeout(() => { void load() }, preparationJobPollMs)
    })
    if (pollMs === null || handledToken.current !== refreshToken) {
      handledToken.current = refreshToken
      failures.current = { any: 0, all: 0 }
      void load()
    }
    if (pollMs === null) return () => { clearTimeout(retryTimer); controller.abort() }
    const timer = setInterval(() => { if (failures.current.all < maxPollingFailures) void load() }, pollMs)
    return () => { clearInterval(timer); clearTimeout(retryTimer); controller.abort() }
  }, [accountEmail, dispatch, pollMs, refreshToken, useCase])

  return null
}
