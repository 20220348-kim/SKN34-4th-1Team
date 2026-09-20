import { Outlet, useLocation, useNavigate } from 'react-router'

import { GuestSearchLayout } from '../../../shared/support-program/GuestSearchLayout'
import { SearchModeTabs } from '../../../shared/support-program/SearchModeTabs'
import { getSupportProgramSearchReturnTo } from './supportProgramNavigation'

/**
 * 비로그인 공고 상세·원문 질문의 껍데기입니다. 검색 화면과 같은 공용 헤더·검색 탭을 그대로 두고 그 아래에 상세를 띄워
 * 검색에서 상세로 갈 때 위쪽이 바뀌지 않게 합니다. 탭은 들어온 검색 방식을 선택된 상태로 보여 주고, 누르면 그 검색
 * 화면으로 돌아갑니다(같은 탭은 필터까지 복원, 다른 탭은 그 검색의 처음 화면).
 */
export function GuestSearchDetailLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const searchReturnTo = getSupportProgramSearchReturnTo(location.state)
  const isFilter = searchReturnTo.includes('mode=filter')
  const select = (filter: boolean) => {
    navigate(filter === isFilter ? searchReturnTo : filter ? '/?mode=filter' : '/')
  }

  return (
    <GuestSearchLayout showConversationPanel={false} searchTabs={<SearchModeTabs isFilter={isFilter} onSelect={select} controlsPanels={false} />} onNewChat={() => select(false)}>
      <div className="flex-1">
        <Outlet />
      </div>
    </GuestSearchLayout>
  )
}
