import { useEffect, useState } from 'react'

/** 좁은 폭(모바일 카드·시트) 기준입니다. Tailwind의 `max-chat`(47.5rem)과 같습니다. */
export const narrowViewportQuery = '(max-width: 759px)'

/**
 * 미디어 쿼리 일치 여부입니다. 같은 내용을 표와 카드처럼 두 벌로 그리지 않고 폭에 맞는 한 벌만 그릴 때 씁니다.
 * `matchMedia`가 없는 환경(테스트)에서는 false(넓은 화면)로 둡니다.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [query])

  return matches
}
