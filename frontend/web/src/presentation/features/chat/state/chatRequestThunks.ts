import type { AppDispatch, AppThunkExtra, RootState } from '../../../../app/store'
import { interpretationCancelled, searchCancelled } from './chatSlice'

/** 진행 중인 검색·조건 해석이 있는지입니다. 다른 대화를 열기 전에 확인하는 데 씁니다. */
export function hasActiveChatRequest(state: RootState): boolean {
  return state.chat.searchStatus === 'pending' || state.chat.interpretation.status === 'pending'
}

/**
 * 스토어가 쥔 진행 중 요청을 끊고 Redux를 취소 상태로 돌립니다. 검색어는 입력창에 되돌아옵니다.
 * 새 대화·다른 대화 열기·취소 버튼이 같은 규칙을 씁니다.
 */
export function cancelActiveChatRequests() {
  return (dispatch: AppDispatch, _getState: () => RootState, requests: AppThunkExtra) => {
    const interpretation = requests.takeInterpretation()
    if (interpretation) dispatch(interpretationCancelled(interpretation.requestId))
    const search = requests.takeSearch()
    if (search) dispatch(searchCancelled({ query: search.query ?? '', requestId: search.requestId }))
  }
}
