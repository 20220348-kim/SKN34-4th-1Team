import { Fragment, useEffect, useRef, useState } from 'react'

import { chatPageStyles } from './ChatPage.styles'

const titleLines = ['우리 회사에 맞는 지원사업,', 'AI와 함께 무료로 찾아보세요.']
const replayIntervalMilliseconds = 40_000

/** 제목의 기존 등장·강조 효과를 유지하며, 보이는 동안에만 드물게 글자별 등장을 반복합니다. */
export function SearchIntroTitle() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [cycle, setCycle] = useState(0)
  const [isTyping, setIsTyping] = useState(true)

  useEffect(() => {
    const title = titleRef.current
    if (!title || typeof window.matchMedia !== 'function' || typeof IntersectionObserver !== 'function') return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let isInView = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      timer = undefined
      if (!isInView || document.hidden || reducedMotion.matches) {
        setIsTyping(false)
        return
      }
      timer = setTimeout(() => {
        setIsTyping(true)
        setCycle((previous) => previous + 1)
        schedule()
      }, replayIntervalMilliseconds)
    }
    const observer = new IntersectionObserver(([entry]) => {
      isInView = entry.isIntersecting && entry.intersectionRatio >= 0.5
      schedule()
    }, { threshold: 0.5 })
    observer.observe(title)
    reducedMotion.addEventListener('change', schedule)
    document.addEventListener('visibilitychange', schedule)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      reducedMotion.removeEventListener('change', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [])

  let characterIndex = 0
  const renderLine = (line: string) => line.split(' ').map((word, wordIndex) => {
    if (wordIndex > 0) characterIndex += 1
    return <Fragment key={wordIndex}>
      {wordIndex > 0 ? ' ' : null}
      <span className={word === '무료로' ? chatPageStyles.introTitleFreeWord : chatPageStyles.introTitleWord}>
        {Array.from(word).map((character, index) => <span key={`${cycle}-${index}`} data-title-character=""
          className={isTyping ? chatPageStyles.introTitleCharacter : undefined}
          style={{ animationDelay: `${180 + characterIndex++ * 55}ms` }}>{character}</span>)}
      </span>
    </Fragment>
  })

  return <h1 ref={titleRef} className={chatPageStyles.introTitle} aria-label={titleLines.join(' ')}>
    <span aria-hidden="true" data-title-line="" className={chatPageStyles.introTitleLine}>
      {renderLine(titleLines[0])}
    </span>{' '}<br />
    <span aria-hidden="true" data-title-line="" className={`${chatPageStyles.introTitleLine} ${chatPageStyles.introTitleSecondLine}`}>
      <span data-title-highlight="" className={chatPageStyles.introTitleHighlight}>{renderLine(titleLines[1])}</span>
    </span>
  </h1>
}
