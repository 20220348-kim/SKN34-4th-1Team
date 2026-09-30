import { Fragment, type ReactNode, useLayoutEffect, useRef } from 'react'
import { Link } from 'react-router'

import { workspacePageStyles } from './WorkspacePage.styles'

/**
 * 로그인 뒤 작업 화면들이 함께 쓰는 머리글입니다. 제목을 왼쪽에, 버튼·태그 같은 동작을 오른쪽 끝에 둡니다.
 * 머리글은 "어디인지와 주 동작"만 담는 한 줄이라 화면이 바뀌어도 높이가 같습니다. 공고명 같은 맥락 문장은 본문 첫 줄에 둡니다.
 * - [parent]에 상위 화면 또는 순서대로 나열한 배열을 주면 제목 앞에 이동 링크가 붙습니다.
 * - 600px 미만에서는 경로를 숨기고, [parent]가 있으면 바로 위 화면으로 가는 [←]과 제목, 오른쪽 동작만 한 줄로 둡니다.
 * - [tabs]를 주면 제목 바로 옆 같은 줄에 화면을 오가는 탭이 붙습니다.
 * 머리글은 스크롤 칸 위쪽에 붙으므로, 같은 칸 안의 다른 sticky 요소가 그 아래에 붙을 수 있게
 * 머리글 높이를 부모(스크롤 칸)의 `--workspace-header-h`로 알립니다.
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
  const headerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const header = headerRef.current
    const host = header?.parentElement
    if (!header || !host) return
    const update = () => host.style.setProperty('--workspace-header-h', `${header.offsetHeight}px`)
    update()
    // 폭이 바뀌어 머리글이 줄거나 늘면(600px 경계의 한 줄 전환 포함) 테두리까지 포함한 높이로 다시 알립니다.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(header, { box: 'border-box' })
    return () => {
      observer?.disconnect()
      host.style.removeProperty('--workspace-header-h')
    }
  }, [])

  const crumbs = parent ? (Array.isArray(parent) ? parent : [parent]) : []
  const back = crumbs[crumbs.length - 1]
  const compact = back ? workspacePageStyles.headerCompactItem : ''

  return (
    <header className={workspacePageStyles.header} ref={headerRef}>
      <div className={`${workspacePageStyles.headerTitleGroup} ${compact}`}>
        {back ? (
          <Link className={workspacePageStyles.headerBackLink} to={back.to} aria-label={`${back.label}${directionParticle(back.label)} 돌아가기`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5M11 18l-6-6 6-6" />
            </svg>
          </Link>
        ) : null}
        {back ? (
          <nav className={workspacePageStyles.headerCrumb} aria-label="상위 화면">
            {crumbs.map((crumb) => <Fragment key={crumb.to}>
              <Link className={workspacePageStyles.headerCrumbLink} to={crumb.to}>
                {crumb.label}
              </Link>
              <CrumbSeparator />
            </Fragment>)}
          </nav>
        ) : null}
        <h1 className={`${workspacePageStyles.title} ${back ? workspacePageStyles.headerCompactTitle : ''}`}>{title}</h1>
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

/** "신청 문서 작성으로", "파트너 관리로"처럼 받침에 맞는 조사를 고릅니다. 한글로 끝나지 않으면 "(으)로"입니다. */
function directionParticle(label: string) {
  const code = label.charCodeAt(label.length - 1) - 0xac00
  if (code < 0 || code > 11171) return '(으)로'
  const final = code % 28
  return final === 0 || final === 8 ? '로' : '으로'
}

function CrumbSeparator() {
  return (
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
  )
}
