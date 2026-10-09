import type { ReactNode } from 'react'

/**
 * 빈 화면(`EmptyState`) 회색 원 안에 그리는 선 아이콘입니다. 맞춤 리포트 빈 화면 아이콘과 같은 20px · 1.75 선으로
 * 화면마다 무엇이 비었는지만 구분합니다. 장식이라 낭독하지 않습니다.
 */
function EmptyStateIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** 맞춤 리포트(받은 리포트가 쌓이는 상자)입니다. */
export function ReportTrayIcon() {
  return <EmptyStateIcon><path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7" /><path d="M4 13h4l1.5 3h5L16 13h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></EmptyStateIcon>
}

/** 관심 공고(빈 책갈피)입니다. 담긴 공고 표시는 칠한 책갈피를 따로 씁니다. */
export function BookmarkOutlineIcon() {
  return <EmptyStateIcon><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></EmptyStateIcon>
}

/** 검색어·필터 때문에 결과가 비었을 때입니다. */
export function SearchIcon() {
  return <EmptyStateIcon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></EmptyStateIcon>
}

/** 기업 정보를 먼저 등록해야 쓸 수 있을 때입니다. */
export function BuildingIcon() {
  return <EmptyStateIcon><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 21v-4h6v4" /><path d="M8 7h2M14 7h2M8 11h2M14 11h2" /></EmptyStateIcon>
}
