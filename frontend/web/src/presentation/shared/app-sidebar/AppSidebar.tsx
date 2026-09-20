import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import type { Account } from '../../../domain/entities/Account'
import { useAppSelector } from '../../../app/hooks'
import { selectChatActivity } from '../../features/chat/state/chatSlice'
import { useAuthSession } from '../auth/hooks/useAuthSession'
import { ChatActivityDot } from '../chat-activity/ChatActivityDot'
import { usePendingReceivedProposalCount } from '../partner-proposal/useReceivedProposals'
import { appPaths, publicPaths } from '../routes/appPaths'
import { useFloatingPopover } from '../workspace/useFloatingPopover'
import { appSidebarStyles, sidebarMenuItemClassName } from './AppSidebar.styles'
import type { ChatHistoryViewModel } from '../../features/chat/hooks/useChatHistory'

type MenuIcon = 'search' | 'document' | 'bookmark' | 'users' | 'inbox' | 'building' | 'shield' | 'pricing' | 'logout' | 'more' | 'newChat' | 'panel' | 'trash'

/** 사이드바 메뉴 한 줄입니다. `to`가 없으면 아직 화면이 없는 메뉴이므로 링크로 만들지 않습니다. */
type MenuItem = {
  label: string
  icon: MenuIcon
  to?: string
  badge?: string
  matches?: (pathname: string) => boolean
}

type MenuGroup = { title: string; items: MenuItem[] }

// 순서는 사용 빈도와 업무 흐름(찾기 → 모아두기 → 준비·검토 → 협업 → 결제)을 따르고, 도우미 도움말 주제 순서와 맞춥니다.
const menuGroups: MenuGroup[] = [
  {
    title: '메뉴',
    items: [
      { label: '관심 공고함', icon: 'bookmark', to: appPaths.savedPrograms, matches: (pathname) => pathname.startsWith(appPaths.savedPrograms) },
      { label: '기업 맞춤 리포트', icon: 'inbox', to: appPaths.reports, matches: (pathname) => pathname === appPaths.reports },
      { label: '신청 문서 작성', icon: 'document', to: appPaths.applicationPreparations, matches: (pathname) => pathname.startsWith(appPaths.applicationPreparations) },
      { label: '중복 지원·수혜 검토', icon: 'shield', to: appPaths.combinationReviews, matches: (pathname) => pathname.startsWith(appPaths.combinationReviews) },
      {
        label: '파트너 관리',
        icon: 'users',
        to: appPaths.partners,
        // 모집글과 제안함은 한 메뉴 아래 탭으로 오갑니다.
        matches: (pathname) => pathname.startsWith(appPaths.partners) || pathname.startsWith(appPaths.proposals),
      },
      { label: '요금제', icon: 'pricing', to: appPaths.pricing, matches: (pathname) => pathname === appPaths.pricing },
    ],
  },
]

const iconPaths: Record<MenuIcon, ReactNode> = {
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  newChat: <><path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6" /><path d="m16 3 5 5-9 9H7v-5Z" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>,
  pricing: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 13h5l1.5 2h3L15 13h5" />
    </>
  ),
  document: (
    <>
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M14 2v6h6M9 13h8M9 17h6" />
    </>
  ),
  bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  users: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </>
  ),
  // 세로 점 세 개(⋮): 누르면 더 많은 항목이 열린다는 뜻으로 널리 쓰이는 모양입니다.
  more: (
    <>
      <circle cx="12" cy="5" r="1.1" fill="currentColor" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" />
      <circle cx="12" cy="19" r="1.1" fill="currentColor" />
    </>
  ),
}

function MenuIconGraphic({ name }: { name: MenuIcon }) {
  return (
    <svg
      width="20"
      height="20"
      className="shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  )
}

export function SidebarActionIcon({ name }: { name: 'newChat' | 'panel' }) {
  return <MenuIconGraphic name={name} />
}

/** 계정 카드에 보여 줄 단계 문구입니다. 기업을 등록하면 상호를, 아니면 등록 안내를 봅니다. */
function tierLabel(account: Account): string {
  if (account.tier === 'ADMIN') return '관리자'
  if (account.company !== null) return `${account.company.companyName} · 기업 회원`
  return account.emailVerified ? '회원 · 기업 미등록' : '회원 · 이메일 미인증'
}

/**
 * 로그인 뒤 작업 화면의 사이드바입니다. 공용 헤더를 대신해 화면 이동과 계정 진입점을 담당합니다.
 * 계정 정보는 세션에서 읽고, 관리자 메뉴는 관리자에게만 그리며, 화면이 없는 메뉴는 링크로 만들지 않습니다.
 * 로그인한 사용자는 `/app` 아래에만 머무르므로 공개 화면으로 가는 링크는 두지 않습니다.
 */
export function AppSidebar({ onClose, onNewChat, closeLabel, onNavigate, history, onOpenHistory, onDeleteHistory }: {
  onClose: () => void
  onNewChat: () => void
  closeLabel: string
  onNavigate: () => void
  history: ChatHistoryViewModel
  onOpenHistory: (id: string) => void
  /** 삭제 확인 대화상자는 모바일 메뉴 <dialog> 밖에 떠야 하므로 레이아웃이 띄웁니다. */
  onDeleteHistory: (id: string, title: string) => void
}) {
  const { pathname } = useLocation()
  const { account, logOut } = useAuthSession()
  const navigate = useNavigate()
  const pendingProposalCount = usePendingReceivedProposalCount()
  // 해당 대화 기록 항목의 점은 조건 해석·검색 진행 중과 아직 보지 않은 결과를 모두 표시합니다.
  const chatActivity = useAppSelector(selectChatActivity)
  const isSearchPage = pathname === appPaths.chat || pathname.startsWith(appPaths.supportProgramDetail)
  // 계정 카드를 누르면 내 프로필·로그아웃과 관리자 전용 회원·기업 메뉴가 열립니다.
  // 화면을 옮기거나 Esc·바깥 클릭이면 닫힙니다.
  const accountMenuId = useId()
  const accountRef = useRef<HTMLDivElement>(null)
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  // 계정 메뉴는 카드와 같은 폭으로 위에 펼치고, 위 공간이 모자라면 안에서 스크롤합니다.
  const accountMenuFloating = useFloatingPopover({ open: isAccountMenuOpen, placement: 'top-start', gap: 8, matchReferenceWidth: true })

  useEffect(() => {
    setIsAccountMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!isAccountMenuOpen) return
    function closeOnOutside(event: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setIsAccountMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsAccountMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isAccountMenuOpen])

  /** 로그아웃하면 공개 메인 화면으로 돌아갑니다. */
  function signOutToLanding() {
    if ((history.saving || history.saveError || history.deletingId !== null) && !window.confirm('아직 저장 또는 삭제가 완료되지 않은 대화가 있습니다. 작업을 완료하지 않고 로그아웃할까요?')) return
    // 로그아웃 상태를 먼저 동기로 그려 보호 라우트의 로그인 이동을 끝낸 뒤, 마지막 이동을 메인으로 잡습니다.
    flushSync(() => {
      void logOut()
    })
    navigate(publicPaths.landing, { replace: true })
  }

  /** 파트너 관리는 받은 제안 대기 건수를 배지로 보여 줍니다. 나머지 메뉴는 고정 문구를 씁니다. */
  function badgeFor(item: MenuItem): string | undefined {
    if (item.to === appPaths.partners) return pendingProposalCount === null || pendingProposalCount === 0 ? undefined : String(pendingProposalCount)
    return item.badge
  }

  return (
    <aside className={appSidebarStyles.sidebar} aria-label="작업 사이드바"
      onClick={(event) => { if ((event.target as Element).closest('a')) onNavigate() }}>
      <div className={appSidebarStyles.brandRow}>
        <Link className={appSidebarStyles.brand} to={appPaths.chat}>
          <span className={appSidebarStyles.brandMark} aria-hidden="true">G</span>
          <strong className={appSidebarStyles.brandTitle}>GovBiz</strong>
        </Link>
        <button type="button" className={appSidebarStyles.iconButton} aria-label={closeLabel} title={closeLabel}
          onClick={onClose}><SidebarActionIcon name="panel" /></button>
      </div>

      <div className={appSidebarStyles.scrollArea}>
        <button type="button" className={`${appSidebarStyles.newChatButton} ${sidebarMenuItemClassName(isSearchPage ? 'active' : 'inactive')}`}
          aria-current={isSearchPage ? 'page' : undefined} title="대화와 적용 조건을 초기화합니다" onClick={onNewChat}>
          <MenuIconGraphic name="search" /><span>지원사업 새검색</span>
        </button>
        {menuGroups
          .map((group) => (
            <nav className={appSidebarStyles.menuGroup} key={group.title} aria-label={group.title}>
              <p className="sr-only">{group.title}</p>
              {group.items.map((item) =>
                item.to ? (
                  <Link
                    className={sidebarMenuItemClassName(
                      item.matches?.(pathname) ? 'active' : 'inactive',
                    )}
                    key={item.label}
                    to={item.to}
                    aria-current={item.matches?.(pathname) ? 'page' : undefined}
                  >
                    <MenuIconGraphic name={item.icon} />
                    <span>{item.label}</span>
                    {badgeFor(item) ? <span className={appSidebarStyles.menuBadge}>{badgeFor(item)}</span> : null}
                  </Link>
                ) : (
                  <span
                    className={sidebarMenuItemClassName('pending')}
                    key={item.label}
                    aria-disabled="true"
                  >
                    <MenuIconGraphic name={item.icon} />
                    <span>{item.label}</span>
                    {item.badge ? <span className={appSidebarStyles.pendingBadge}>{item.badge}</span> : null}
                  </span>
                ),
              )}
            </nav>
          ))}
        {account ? <section className="mt-6 flex flex-col gap-1" aria-label="대화 기록">
          <h2 className="mb-1 px-3 text-xs font-medium text-[#888]">대화 기록</h2>
          {history.items.map((item) => <div key={item.id} className="flex min-w-0 items-center gap-1">
            <button type="button" disabled={history.deletingId === item.id}
            className={`${sidebarMenuItemClassName(history.activeId === item.id && pathname === appPaths.chat ? 'active' : 'inactive')} min-w-0 flex-1 cursor-pointer border-0 text-left disabled:cursor-wait disabled:opacity-60`}
            aria-label={`대화 열기: ${item.title}`} title={item.title}
            aria-current={history.activeId === item.id && pathname === appPaths.chat ? 'page' : undefined}
            onClick={() => onOpenHistory(item.id)}>
            <span className="min-w-0 flex-1 truncate font-normal">{item.title}</span>
            {/* 검색 중이거나 결과가 도착한 대화는 글자 대신 점으로 표시해 좁은 폭에서도 잘리지 않습니다. */}
            {chatActivity && history.activeId === item.id ? <ChatActivityDot activity={chatActivity} /> : null}
            {history.openingId === item.id ? <span className="shrink-0 text-xs">여는 중</span> : null}
            </button>
            <button type="button" className={`${appSidebarStyles.iconButton} min-h-11 min-w-11 hover:text-red-700 disabled:cursor-wait disabled:opacity-40`}
              disabled={history.deletingId !== null} aria-label={`대화 삭제: ${item.title}`} title="대화 삭제"
              onClick={() => onDeleteHistory(item.id, item.title)}><MenuIconGraphic name="trash" /></button>
          </div>)}
          {history.deletingId !== null ? <p className="px-3 text-xs text-[#888]" role="status">대화 삭제 중…</p> : null}
          {history.deleteError ? <p className="px-3 text-xs text-red-700" role="alert">{history.deleteError}</p> : null}
          {history.loading ? <p className="px-3 text-xs text-[#888]" role="status">기록을 불러오는 중…</p> : null}
          {!history.loading && !history.loadError && history.items.length === 0 ? <p className="px-3 text-xs text-[#888]">대화를 시작하면 여기에 저장됩니다.</p> : null}
          {history.loadError ? <p className="px-3 text-xs text-red-700" role="alert">{history.loadError}</p> : null}
          {history.nextCursor !== null || history.loadError ? <button type="button" className={appSidebarStyles.accountMenuButton}
            disabled={history.loading} onClick={history.loadMore}>{history.loadError ? '기록 다시 불러오기' : '이전 기록 더 보기'}</button> : null}
          {history.saveError ? <div className="px-3 text-xs text-red-700" role="alert">
            <p>저장하지 못한 대화가 있습니다. 연결 오류·다른 창의 변경·저장 크기 제한 등을 확인해 주세요. 저장 전에는 이 창을 닫지 마세요.</p>
            <button type="button" className="cursor-pointer underline" onClick={history.retrySave}>대화 저장 재시도</button>
          </div> : history.saving ? <p className="px-3 text-xs text-[#888]" role="status">대화 저장 중…</p> : null}
        </section> : null}
      </div>

      {account ? (
        <div className={appSidebarStyles.account} ref={accountRef}>
          {isAccountMenuOpen ? (
            <div ref={accountMenuFloating.floating} style={accountMenuFloating.floatingStyles}
              className={appSidebarStyles.accountMenu} id={accountMenuId} aria-label="계정 메뉴">
              <Link
                className={sidebarMenuItemClassName(pathname.startsWith(appPaths.profile) ? 'active' : 'inactive')}
                to={appPaths.profile}
                aria-current={pathname.startsWith(appPaths.profile) ? 'page' : undefined}
              >
                <MenuIconGraphic name="building" />
                <span>내 프로필</span>
              </Link>
              {account.tier === 'ADMIN' ? (
                <Link
                  className={sidebarMenuItemClassName(pathname.startsWith(appPaths.admin) ? 'active' : 'inactive')}
                  to={appPaths.adminAccounts}
                  aria-current={pathname.startsWith(appPaths.admin) ? 'page' : undefined}
                >
                  <MenuIconGraphic name="shield" />
                  <span>회원·기업</span>
                </Link>
              ) : null}
              <button className={appSidebarStyles.accountMenuButton} type="button" onClick={signOutToLanding}>
                <MenuIconGraphic name="logout" />
                <span>로그아웃</span>
              </button>
            </div>
          ) : null}
          <button
            ref={accountMenuFloating.reference}
            className={appSidebarStyles.accountCard}
            type="button"
            aria-label={`계정 메뉴 · ${account.email}`}
            aria-expanded={isAccountMenuOpen}
            aria-controls={isAccountMenuOpen ? accountMenuId : undefined}
            onClick={() => setIsAccountMenuOpen((open) => !open)}
          >
            <span className={appSidebarStyles.accountAvatar} aria-hidden="true">
              {account.email.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <strong className={appSidebarStyles.accountName} title={account.email}>{account.email}</strong>
              <span className={appSidebarStyles.accountCompany}>{tierLabel(account)}</span>
            </span>
            {/* ⋮ 아이콘으로 이 카드가 계정 메뉴를 여는 버튼임을 알립니다. */}
            <span className={appSidebarStyles.accountMenuIcon} aria-hidden="true">
              <MenuIconGraphic name="more" />
            </span>
          </button>
        </div>
      ) : null}
    </aside>
  )
}
