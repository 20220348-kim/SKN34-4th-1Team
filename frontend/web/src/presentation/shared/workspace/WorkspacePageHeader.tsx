import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'

import { workspacePageStyles } from './WorkspacePage.styles'

/**
 * 로그인 뒤 작업 화면들이 함께 쓰는 머리글입니다. 제목을 왼쪽에, 버튼·태그 같은 동작을 오른쪽 끝에 둡니다.
 * - [parent]에 상위 화면 또는 순서대로 나열한 배열을 주면 제목 앞에 이동 링크가 붙습니다.
 * - [tabs]를 주면 제목 바로 옆 같은 줄에 화면을 오가는 탭이 붙습니다.
 */
export function WorkspacePageHeader({
  parent,
  title,
  tabs,
  actions,
}: {
  parent?: { to: string; label: string } | { to: string; label: string }[]
  title: string
  tabs?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className={workspacePageStyles.header}>
      <div className={workspacePageStyles.headerTitleGroup}>
        {parent ? (
          <nav className={workspacePageStyles.headerCrumb} aria-label="상위 화면">
            {(Array.isArray(parent) ? parent : [parent]).map((crumb) => <Fragment key={crumb.to}>
            <Link className={workspacePageStyles.headerCrumbLink} to={crumb.to}>
              {crumb.label}
            </Link>
            <svg
              className={workspacePageStyles.headerCrumbSeparator}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            </Fragment>)}
          </nav>
        ) : null}
        <h1 className={workspacePageStyles.title}>{title}</h1>
      </div>
      {tabs ? (
        <>
          <span className={workspacePageStyles.headerDivider} aria-hidden="true" />
          <div className={workspacePageStyles.headerTabs}>{tabs}</div>
        </>
      ) : null}
      {actions ? <div className={workspacePageStyles.headerActions}>{actions}</div> : null}
    </header>
  )
}
