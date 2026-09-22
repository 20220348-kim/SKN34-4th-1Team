import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { AppHeader } from '../app-header/AppHeader'
import { publicPaths } from '../routes/appPaths'

/**
 * 비로그인 검색 흐름(검색·공고 상세·원문 질문)이 함께 쓰는 껍데기입니다. 스크롤은 PublicLayout의 안쪽 칸이 맡습니다.
 * 공용 헤더는 화면 위에, 가로 검색 탭은 헤더 바로 아래에 붙고, 대화가 있는 AI 검색 탭에서만 보이는 왼쪽 보조 패널은
 * 탭 아래에 붙습니다. 탭 줄은 폭이 달라지는 패널·본문 행 밖의 공통 영역에 둡니다.
 */
export function GuestSearchLayout({ children, searchTabs, onNewChat, showConversationPanel }: {
  showConversationPanel: boolean
  children: ReactNode
  searchTabs: ReactNode
  onNewChat: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const tabsRowRef = useRef<HTMLDivElement>(null)
  // 헤더가 창 너비에 따라 두 줄이 될 수 있어 실제 높이를 재서 탭 줄과 보조 패널이 붙는 위치를 정합니다.
  const [headerHeight, setHeaderHeight] = useState(0)
  const [tabsRowHeight, setTabsRowHeight] = useState(0)
  useEffect(() => {
    // AppHeader의 바깥 껍데기(sticky 띠)가 첫 자식입니다. 그 높이 아래에 탭 줄이 붙습니다.
    const header = rootRef.current?.firstElementChild
    const tabsRow = tabsRowRef.current
    if (!header || !tabsRow || typeof ResizeObserver !== 'function') return
    const update = () => {
      setHeaderHeight(header.getBoundingClientRect().height)
      setTabsRowHeight(tabsRow.getBoundingClientRect().height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    observer.observe(tabsRow)
    return () => observer.disconnect()
  }, [])

  return <div ref={rootRef} className="flex flex-1 flex-col bg-white">
    <AppHeader />
    <div className="mx-auto flex w-[calc(100%_-_2.5rem)] max-w-[1400px] flex-1 flex-col pb-5 min-[640px]:w-[calc(100%_-_3rem)] max-chat:w-[calc(100%_-_1rem)] max-chat:pb-2">
      <div ref={tabsRowRef} style={{ top: headerHeight }}
        className="sticky z-[4] flex shrink-0 justify-center bg-white px-4 pt-5 pb-2 max-chat:px-0 max-chat:pt-3">{searchTabs}</div>
      <div className="flex min-w-0 flex-1 items-start gap-5 max-chat:gap-2">
        {showConversationPanel ? <aside aria-label="AI 대화 도구" style={{ top: headerHeight + tabsRowHeight }}
          className="sticky flex w-60 shrink-0 flex-col gap-5 rounded-[1.8rem] border border-[#dce2de] bg-white px-4 py-5 shadow-[0_2px_12px_rgb(0_0_0_/_4%)] max-[1100px]:w-52 max-chat:w-14 max-chat:gap-3 max-chat:rounded-2xl max-chat:px-1 max-chat:py-2">
          <button type="button" onClick={onNewChat} title="새 AI 대화 검색"
            className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-2xl bg-[#f1f6f3] px-3 py-3 text-left text-sm font-semibold text-brand-primary hover:bg-[#e6f1ea] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary max-chat:justify-center max-chat:px-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
              strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
              <path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6" /><path d="m16 3 5 5-9 9H7v-5Z" />
            </svg>
            <span className="max-chat:sr-only">새 AI 대화 검색</span>
          </button>
          <Link to={publicPaths.login} aria-label="활동을 저장하려면 로그인을 해주세요" title="활동을 저장하려면 로그인을 해주세요"
            className="flex min-h-11 items-start gap-2 rounded-xl px-1 py-1 text-xs leading-6 text-sample-muted no-underline hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary max-chat:items-center max-chat:justify-center max-chat:px-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" className="mt-0.5 shrink-0 max-chat:mt-0" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" />
            </svg>
            <span className="max-chat:sr-only">활동을 저장하려면 <span className="font-medium underline underline-offset-2">로그인</span>을 해주세요</span>
          </Link>
        </aside> : null}
        <div className="flex min-w-0 flex-1 flex-col self-stretch">
          {children}
        </div>
      </div>
    </div>
  </div>
}
