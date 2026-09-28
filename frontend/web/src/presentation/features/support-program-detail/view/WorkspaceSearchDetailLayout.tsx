import { Link, Outlet, useLocation, useNavigate } from 'react-router'

import { appPaths } from '../../../shared/routes/appPaths'
import { SearchModeTabs, WorkspaceSearchTabsRow } from '../../../shared/support-program/SearchModeTabs'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'
import { supportProgramDetailStyles as s } from './SupportProgramDetailPage.styles'
import { getSupportProgramSearchReturnTo, isSavedProgramsReturnTo, supportProgramBackLabel } from './supportProgramNavigation'

/**
 * 로그인 뒤 공고 상세·원문 질문의 껍데기입니다. 상세는 "어디서 열었는지"를 그대로 이어받습니다.
 * - 검색에서 열었으면 작업 검색 화면과 같은 검색 탭 줄을 위에 두고, 누르면 그 검색 화면으로 돌아갑니다(같은 탭은 조건 복원).
 * - 관심 공고함에서 열었으면 관심 공고함 머리글과 같은 높이의 줄에 돌아가기 알약만 두어 목록↔상세 전환 때 위쪽이 흔들리지 않게 합니다.
 * 비로그인 상세는 `GuestSearchDetailLayout`이 같은 역할을 합니다.
 */
export function WorkspaceSearchDetailLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const searchReturnTo = getSupportProgramSearchReturnTo(location.state, location.search)

  if (isSavedProgramsReturnTo(searchReturnTo)) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={workspacePageStyles.header}>
          {/* 관심 공고함 머리글의 제목 줄과 같은 최소 높이(2.5rem)를 두어 목록↔상세 전환 때 줄 높이가 같습니다. */}
          <div className={workspacePageStyles.headerTitleGroup}>
          <Link className={s.backLink} to={searchReturnTo}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="m15 18-6-6 6-6" />
            </svg>
            {supportProgramBackLabel(searchReturnTo)}
          </Link>
          </div>
        </div>
        <Outlet />
      </div>
    )
  }

  const isFilter = searchReturnTo.includes('mode=filter')
  const select = (filter: boolean) => {
    navigate(filter === isFilter ? searchReturnTo : filter ? `${appPaths.chat}?mode=filter` : appPaths.chat)
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceSearchTabsRow>
        <SearchModeTabs isFilter={isFilter} onSelect={select} controlsPanels={false} />
      </WorkspaceSearchTabsRow>
      <Outlet />
    </div>
  )
}
