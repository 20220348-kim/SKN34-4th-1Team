import { type RefObject, useEffect } from 'react'
import { useLocation } from 'react-router'

/**
 * 경로(pathname)가 바뀌면 스크롤을 맨 위로 돌립니다. SPA는 문서를 다시 읽지 않아 브라우저가 스크롤을 되돌리지 않고,
 * 로그인 뒤 화면은 문서가 아니라 작업 칸(div)이 스크롤하므로 그 요소를 넘겨 받습니다. 넘기지 않으면 문서를 돌립니다.
 * 쿼리만 바뀌는 탭 전환(`?mode=filter`)이나 같은 화면 안의 이동은 그대로 둡니다.
 */
export function useResetScrollOnNavigate(container?: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation()
  useEffect(() => {
    const targets = container ? [container.current] : [document.documentElement, document.body]
    for (const target of targets) {
      if (!target) continue
      target.scrollTop = 0
      target.scrollLeft = 0
    }
  }, [container, pathname])
}
