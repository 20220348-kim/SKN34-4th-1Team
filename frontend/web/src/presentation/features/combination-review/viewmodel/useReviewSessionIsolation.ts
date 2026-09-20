import { useEffect } from 'react'
import { useStore } from 'react-redux'
import type { RootState } from '../../../../app/store'
import { appContainer } from '../../../../app/appContainer'

/** 페이지 밖에서 로그아웃해도 응답 유실 요청의 개인 진술을 지운다. */
export function useReviewSessionIsolation() {
  const store = useStore<RootState>()
  useEffect(() => {
    let previous = store.getState().auth
    const clear = () => { try { appContainer.resolve('reviewRequestJournal').clear() } catch { /* 저장소 접근이 차단된 환경 */ } }
    if (previous.status === 'anonymous') clear()
    return store.subscribe(() => {
      const next = store.getState().auth
      if (next !== previous && (next.status === 'anonymous' || (previous.status === 'authenticated' && next.account !== previous.account))) clear()
      previous = next
    })
  }, [store])
}
