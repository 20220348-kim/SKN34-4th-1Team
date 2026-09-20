/**
 * 진행 중인 검색·조건 해석 요청의 주인입니다. 화면 컴포넌트가 아니라 스토어와 수명이 같아서
 * 다른 메뉴로 이동해도 요청이 끊기지 않고, 결과는 Redux로 돌아와 화면이 다시 열릴 때 보입니다.
 * thunk의 세 번째 인자(extraArgument)로 전달됩니다.
 */
export type ChatActiveRequest = {
  requestId: string
  controller: AbortController
  timeoutId: ReturnType<typeof setTimeout>
  /** 검색 요청만 갖는 검색어입니다. 취소 시 입력창에 되돌립니다. */
  query?: string
}

export class ChatRequestRegistry {
  search: ChatActiveRequest | null = null
  interpretation: ChatActiveRequest | null = null

  /** 진행 중인 검색을 떼어 내 중단합니다. requestId를 주면 그 요청일 때만 떼어 냅니다. */
  takeSearch(requestId?: string): ChatActiveRequest | null {
    const current = this.search
    if (!current || (requestId !== undefined && current.requestId !== requestId)) return null
    this.search = null
    clearTimeout(current.timeoutId)
    current.controller.abort()
    return current
  }

  takeInterpretation(requestId?: string): ChatActiveRequest | null {
    const current = this.interpretation
    if (!current || (requestId !== undefined && current.requestId !== requestId)) return null
    this.interpretation = null
    clearTimeout(current.timeoutId)
    current.controller.abort()
    return current
  }

  /** 요청이 끝나 더 이상 취소할 것이 없을 때 타이머만 정리합니다. 다른 요청이 등록돼 있으면 건드리지 않습니다. */
  releaseSearch(requestId: string) {
    if (this.search?.requestId !== requestId) return
    clearTimeout(this.search.timeoutId)
    this.search = null
  }

  releaseInterpretation(requestId: string) {
    if (this.interpretation?.requestId !== requestId) return
    clearTimeout(this.interpretation.timeoutId)
    this.interpretation = null
  }
}
