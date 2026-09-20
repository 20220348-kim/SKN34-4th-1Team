import { useRef } from 'react'
import { flushSync } from 'react-dom'
import { useSearchParams } from 'react-router'

import { useAppDispatch, useAppSelector } from '../../../../app/hooks'
import { GuestSearchLayout } from '../../../shared/support-program/GuestSearchLayout'
import { SearchModeTabs } from '../../../shared/support-program/SearchModeTabs'
import { conversationReset, selectConversationCount } from '../../chat/state/chatSlice'
import { ChatPage, type ChatPageLayout } from '../../chat/view/ChatPage'
import { SupportProgramCatalogPanel } from './SupportProgramCatalogPanel'

/** AI 대화는 탭 전환 시에도 유지하고, 목록 조회는 떠날 때 취소합니다. */
export function SupportProgramSearchPage({ layout = 'landing' }: { layout?: ChatPageLayout }) {
  const [params, setParams] = useSearchParams()
  const dispatch = useAppDispatch()
  const contentRef = useRef<HTMLDivElement>(null)
  const isFilter = params.get('mode') === 'filter'
  const isGuest = layout === 'landing'
  const hasConversation = useAppSelector(selectConversationCount) > 0
  const select = (filter: boolean) => {
    const next = new URLSearchParams(params)
    if (filter) next.set('mode', 'filter')
    else next.delete('mode')
    setParams(next)
  }
  const startNewChat = () => {
    // 같은 ChatPage를 유지하면서 요청 ID도 초기화하므로 진행 중 요청과 늦은 응답을 취소합니다.
    flushSync(() => {
      dispatch(conversationReset())
      select(false)
    })
    contentRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="지원사업 검색어"]')?.focus()
  }
  const searchTabs = <SearchModeTabs isFilter={isFilter} onSelect={select} />
  // 스크롤은 껍데기(로그인은 작업 칸, 비로그인은 문서)가 맡으므로 패널 안에는 스크롤 영역을 두지 않습니다.
  const panels = <div ref={contentRef} className="flex min-w-0 flex-1 flex-col">
    <div role="tabpanel" id="search-panel-0" aria-labelledby="search-tab-0" hidden={isFilter} className={isFilter ? 'hidden' : 'flex flex-1 flex-col'}>
      <ChatPage layout={layout} />
    </div>
    <div role="tabpanel" id="search-panel-1" aria-labelledby="search-tab-1" hidden={!isFilter} className={!isFilter ? 'hidden' : 'flex flex-1 flex-col'}>
      {isFilter ? <SupportProgramCatalogPanel /> : null}
    </div>
  </div>

  return isGuest ? <GuestSearchLayout showConversationPanel={hasConversation && !isFilter} searchTabs={searchTabs} onNewChat={startNewChat}>{panels}</GuestSearchLayout>
    : <div className="flex min-w-0 flex-1 flex-col">
      {/* 다른 작업 화면의 머리글처럼 탭 줄만 위에 붙이고 본문은 작업 칸과 함께 스크롤됩니다. */}
      <div className="sticky top-0 z-[3] flex shrink-0 justify-center bg-white px-4 pt-3 pb-2">{searchTabs}</div>
      {panels}
    </div>
}
