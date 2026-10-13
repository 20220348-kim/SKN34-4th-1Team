type SessionEndedListener = () => void

const sessionEndedListeners = new Set<SessionEndedListener>()

/**
 * Core가 로그인 세션 쿠키를 받아 주지 않았다(401)는 신호를 받을 곳을 등록합니다. 등록을 풀 함수를 돌려줍니다.
 * 데이터 계층은 스토어를 모르므로, 로그인 상태를 바꾸는 일은 등록한 쪽(세션 감시 훅)이 맡습니다.
 */
export function onCoreSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener)
  return () => sessionEndedListeners.delete(listener)
}

/**
 * 로그인 세션 쿠키로 부르는 Core API 요청입니다. 401이면 세션이 끝났다고(만료·강제 로그아웃·다른 창 로그아웃) 알리고,
 * 응답은 그대로 돌려줘 화면별 오류 처리는 바꾸지 않습니다. 로그인·회원가입·비밀번호 확인처럼 401이 "입력이 틀림"인
 * 요청과 세션을 따로 쓰는 Ops API는 이 함수를 쓰지 않습니다.
 */
export async function coreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status === 401) sessionEndedListeners.forEach((listener) => listener())
  return response
}
