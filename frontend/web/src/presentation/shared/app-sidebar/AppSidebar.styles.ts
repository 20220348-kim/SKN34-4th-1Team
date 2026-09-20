// 로그인 작업 화면은 메뉴만 스크롤하고 로고와 계정 영역은 위아래에 고정합니다.
export const appSidebarStyles = {
  layout: 'flex h-dvh overflow-hidden bg-white text-app-ink',
  sidebar: 'flex h-full min-h-0 flex-col border-r border-[#ececec] bg-white px-3 pt-2.5 pb-2 text-app-ink',
  brandRow: 'mb-4 flex h-10 shrink-0 items-center justify-between gap-2 px-1',
  brand: 'flex min-w-0 items-center gap-2.5 rounded-lg text-app-ink no-underline focus-visible:outline-2 focus-visible:outline-brand-primary',
  brandMark: 'grid size-8 shrink-0 place-items-center rounded-xl bg-brand-accent text-lg font-black text-brand-primary',
  brandTitle: 'block text-xl font-semibold tracking-tight',
  iconButton: 'grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-[#777] hover:bg-black/5 hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  scrollArea: 'min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4',
  newChatButton: 'mb-1 w-full cursor-pointer border-0 text-left',
  menuGroup: 'flex flex-col gap-1',
  menuItem: 'flex min-h-11 min-w-0 items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-semibold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary [&_svg]:size-[18px]',
  activeMenuItem: 'bg-[#e6f5ed] text-brand-primary hover:bg-[#dcefe5]',
  inactiveMenuItem: 'bg-transparent text-app-ink hover:bg-[#f5f6f7]',
  pendingMenuItem: 'cursor-default bg-[#f5f6f7] text-[#727b86]',
  menuBadge: 'ml-auto inline-flex shrink-0 rounded-full bg-brand-accent px-1.5 py-0.5 text-[0.65rem] font-semibold text-brand-primary',
  pendingBadge: 'ml-auto inline-flex shrink-0 rounded-full bg-[#e9ecef] px-2 py-1 text-[0.6rem] font-semibold leading-none text-[#727b86]',
  account: 'relative mt-auto shrink-0 border-t border-[#e7e7e7] pt-2',
  accountCard: 'flex min-h-14 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-2 text-left hover:bg-black/5 aria-expanded:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  accountMenuIcon: 'ml-auto shrink-0 text-sample-muted',
  // 위치는 useFloatingPopover가 잡습니다(계정 카드 위).
  accountMenu: 'z-20 flex flex-col gap-1 rounded-xl border border-sample-border bg-white p-1.5 shadow-[0_8px_28px_rgb(0_0_0_/_10%)]',
  accountMenuButton: 'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm text-app-ink hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-brand-primary',
  accountAvatar: 'grid size-8 shrink-0 place-items-center rounded-full bg-brand-primary text-sm font-medium text-white',
  accountName: 'block truncate text-sm font-medium text-app-ink',
  accountCompany: 'mt-0.5 block truncate text-xs text-[#888]',
  workspace: '@container/workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto',
  compactHeader: 'flex h-14 shrink-0 items-center gap-2 bg-white px-3',
  mobileDialog: 'fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(280px,85vw)] max-w-none border-0 p-0 backdrop:bg-black/30',
} as const

export function sidebarMenuItemClassName(state: 'active' | 'inactive' | 'pending') {
  const variant =
    state === 'active'
      ? appSidebarStyles.activeMenuItem
      : state === 'pending'
        ? appSidebarStyles.pendingMenuItem
        : appSidebarStyles.inactiveMenuItem
  return `${appSidebarStyles.menuItem} ${variant}`
}
