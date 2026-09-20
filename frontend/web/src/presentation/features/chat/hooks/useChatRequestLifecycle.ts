import { useEffect } from 'react'

import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import type { AppDispatch, AppThunkExtra, RootState } from '../../../../app/store'

/**
 * 앱 최상단에서 한 번 마운트합니다. 로그아웃·계정 변경·새 대화로 Redux의 요청 ID가 바뀌면
 * 스토어가 쥐고 있는 진행 중 HTTP 요청을 끊습니다. 화면 이동으로는 끊지 않습니다.
 */
export function useChatRequestLifecycle() {
  const dispatchToStore = useAppDispatch()
  const searchRequestId = useAppSelector((state) => state.chat.activeRequestId)
  const interpretationRequestId = useAppSelector((state) => state.chat.interpretation.requestId ?? null)

  useEffect(() => {
    dispatchToStore((_dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
      if (requests.search && requests.search.requestId !== searchRequestId) requests.takeSearch()
      if (requests.interpretation && requests.interpretation.requestId !== interpretationRequestId) requests.takeInterpretation()
    })
  }, [dispatchToStore, interpretationRequestId, searchRequestId])
}
