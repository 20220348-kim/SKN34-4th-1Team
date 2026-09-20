import { Link, Outlet } from 'react-router'

import { chatActivityMessages } from '../chat-activity/chatActivityMessages'
import { appPaths } from '../routes/appPaths'
import { WorkspaceModal } from '../workspace/WorkspaceModal'
import { workspaceModalStyles } from '../workspace/WorkspaceModal.styles'
import { workspacePageStyles } from '../workspace/WorkspacePage.styles'
import { AppSidebar, SidebarActionIcon } from './AppSidebar'
import { appSidebarStyles } from './AppSidebar.styles'
import { useWorkspaceLayoutViewModel } from './useWorkspaceLayoutViewModel'

/**
 * 로그인 화면은 본문을 유지한 채 PC 사이드바를 접거나 모바일 메뉴를 엽니다.
 * 상태·동작은 `useWorkspaceLayoutViewModel`이 맡고, 여기에는 JSX·스타일·ARIA와 문구만 둡니다.
 */
export function WorkspaceLayout() {
  const vm = useWorkspaceLayoutViewModel()
  const { pendingAction } = vm

  const sidebar = <AppSidebar onClose={vm.closeSidebar} onNewChat={vm.requestNewChat}
    history={vm.history} onOpenHistory={vm.requestOpenChatHistory} onDeleteHistory={vm.requestDeleteChatHistory}
    closeLabel={vm.closeLabel} onNavigate={vm.closeMenu} />

  return (
    <div className={appSidebarStyles.layout}>
      {vm.isMobile ? <dialog ref={vm.dialogRef} aria-label="작업 메뉴" onClose={vm.closeMenu}
        onClick={(event) => { if (event.target === event.currentTarget) vm.closeSidebar() }}
        className={appSidebarStyles.mobileDialog}>
        {sidebar}
      </dialog> : <div ref={vm.sidebarRef} hidden={vm.isCollapsed}
        className={vm.isCollapsed ? 'hidden' : 'h-full w-[260px] shrink-0'}>
        {sidebar}
      </div>}
      <div className={appSidebarStyles.workspace} ref={vm.workspaceRef}>
        {vm.isMobile || vm.isCollapsed ? <header className={appSidebarStyles.compactHeader} aria-label="작업 메뉴 열기">
          <button ref={vm.menuButtonRef} type="button" className={appSidebarStyles.iconButton}
            aria-label={vm.openLabel} title={vm.openLabel}
            aria-expanded={vm.isMobile ? vm.isMenuOpen : false} aria-haspopup={vm.isMobile ? 'dialog' : undefined}
            onClick={vm.openSidebar}><SidebarActionIcon name="panel" /></button>
          <Link to={appPaths.chat} className="text-lg font-semibold tracking-tight text-app-ink no-underline">GovBiz</Link>
          <button type="button" className={`${appSidebarStyles.iconButton} ml-auto`} aria-label="지원사업 새검색"
            title="지원사업 새검색" onClick={vm.requestNewChat}><SidebarActionIcon name="newChat" /></button>
        </header> : null}
        <Outlet />
      </div>
      {pendingAction?.kind === 'delete' ? (
        <WorkspaceModal isOpen title="대화를 삭제할까요?" tone="danger" onClose={vm.cancelPendingAction}
          description={`“${pendingAction.title}” 대화의 질문·답변·검색 결과가 삭제되며 복구할 수 없습니다.`}>
          <div className={workspaceModalStyles.actions}>
            <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.cancelPendingAction}>취소</button>
            <button className={workspacePageStyles.dangerButton} type="button" onClick={vm.confirmPendingAction}>삭제</button>
          </div>
        </WorkspaceModal>
      ) : (
        <WorkspaceModal isOpen={pendingAction !== null} title={chatActivityMessages.openHistoryTitle}
          description={pendingAction?.kind === 'new' ? chatActivityMessages.newChatDescription : chatActivityMessages.openHistoryDescription}
          onClose={vm.cancelPendingAction}>
          <div className={workspaceModalStyles.actions}>
            <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.cancelPendingAction}>
              {chatActivityMessages.openHistoryCancel}
            </button>
            <button className={workspacePageStyles.primaryButton} type="button" onClick={vm.confirmPendingAction}>
              {chatActivityMessages.openHistoryContinue}
            </button>
          </div>
        </WorkspaceModal>
      )}
    </div>
  )
}
