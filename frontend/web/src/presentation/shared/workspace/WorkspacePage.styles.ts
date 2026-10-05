function classes(...groups: string[]) {
  return groups.join(' ')
}

/** 태그가 나타내는 상태입니다. 색이 아니라 의미로 고르도록 이름을 상태로 둡니다. */
export type WorkspaceTagTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info'

// 로그인 뒤 작업 화면들이 공유하는 UI 조각입니다. 화면별로 다른 배치는 각 화면의 styles 파일이 맡습니다.
export const workspacePageStyles = {
  // 본문이 스크롤돼도 현재 화면 이름과 주요 동작은 남아야 하므로 본문 칸의 위쪽에 붙입니다.
  header: classes(
    'sticky top-0 z-[3] flex flex-wrap items-center justify-between gap-4 border-b border-sample-border',
    'bg-[rgb(255_255_255_/_96%)] backdrop-blur',
    'px-[clamp(1.25rem,5vw,4.5rem)] py-6 max-chat:px-4 max-chat:py-4',
  ),
  // 오른쪽 동작이 버튼(2.5rem)이든 태그든 없든 머리글 높이가 같도록 제목 줄의 최소 높이를 버튼 높이에 맞춥니다.
  headerTitleGroup: 'flex min-h-10 min-w-0 max-w-full flex-wrap items-center gap-2',
  // "파트너 관리 › 모집글 작성"처럼 상위 화면 이름을 제목 앞에 링크로 둡니다. 제목과 같은 크기, 옅은 색.
  // 600px 미만에서는 경로 대신 [← 상위 화면] 한 칸(headerBackLink)만 두어 머리글을 앱 바처럼 한 줄로 줄입니다.
  headerCrumb: 'inline-flex flex-wrap items-center gap-2 max-[599px]:hidden',
  headerBackLink: classes(
    'hidden size-10 shrink-0 place-items-center rounded-full text-app-ink no-underline hover:bg-surface-muted max-[599px]:-ml-2 max-[599px]:grid',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // 상위 화면이 있는 머리글의 600px 미만 한 줄: 제목 묶음이 남는 폭을 차지하고 제목은 한 줄로 줄입니다.
  headerCompactItem: 'max-[599px]:basis-0 max-[599px]:grow max-[599px]:flex-nowrap',
  headerCompactTitle: 'max-[599px]:min-w-0 max-[599px]:truncate',
  headerCrumbLink:
    'text-[1.25rem] font-bold tracking-[-0.04em] whitespace-nowrap text-sample-muted no-underline hover:text-app-ink',
  headerCrumbSeparator: 'shrink-0 text-sample-muted',
  // 제목 옆에 화면을 오가는 탭을 같은 줄로 붙일 때 씁니다. 좁은 폭에서는 세로 구분선을 숨기고, 제목 · 동작을 한 줄에 둔 채
  // 탭 줄만 그 아래 전체 폭 줄로 내립니다.
  headerDivider: 'h-[22px] w-px shrink-0 bg-sample-border max-chat:hidden',
  headerTabs: 'flex min-w-0 grow items-center max-chat:order-last max-chat:basis-full',
  // 제목 옆 세그먼트(관심 공고함 · 제안함 · 파트너 관리가 함께 씀): 연한 회색 알약 묶음 안에서 고른 것만 흰색으로 떠 보입니다.
  // 버튼(aria-selected)과 링크(aria-current="page") 어느 쪽이든 같은 모양입니다. 좁은 폭에서는 칸이 폭을 나눠 가집니다.
  segment: 'inline-flex max-w-full gap-[3px] rounded-full bg-surface-muted p-[3px] max-chat:flex max-chat:w-full',
  segmentTab: classes(
    'inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-3.5 text-[0.8125rem] font-bold whitespace-nowrap text-ink-muted no-underline',
    'hover:text-app-ink aria-selected:bg-white aria-selected:text-app-ink aria-selected:shadow-[0_1px_3px_rgb(32_33_36_/_12%)]',
    'aria-[current=page]:bg-white aria-[current=page]:text-app-ink aria-[current=page]:shadow-[0_1px_3px_rgb(32_33_36_/_12%)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary max-chat:h-[38px] max-chat:flex-1 max-chat:justify-center max-chat:px-2',
  ),
  title: 'm-0 text-[1.25rem] font-bold tracking-[-0.04em] break-words text-app-ink',
  headerActions: 'ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-2',
  content: classes(
    'flex flex-col gap-5 px-[clamp(1.25rem,5vw,4.5rem)] pt-8 pb-12',
    'max-chat:px-4 max-chat:pt-5 max-chat:pb-8',
  ),
  // 사이드바를 제외한 실제 작업 공간이 충분할 때만 보조 패널을 옆에 배치합니다.
  columns: 'grid grid-cols-1 items-start gap-6 @min-[64rem]/workspace:grid-cols-[minmax(0,1fr)_340px]',
  column: '@container/column flex min-w-0 flex-col gap-5',
  card: classes(
    'flex flex-col gap-[0.9rem] rounded-[1.4rem] border border-sample-border bg-white p-[1.35rem]',
    'shadow-[0_8px_24px_rgb(32_33_36_/_4%)]',
  ),
  outlinedCard:
    'flex flex-col gap-[0.9rem] rounded-[1.4rem] border border-dashed border-sample-border bg-white p-[1.35rem]',
  cardHeader: 'flex items-start justify-between gap-4',
  cardTitle: 'm-0 text-[1.02rem] font-bold tracking-[-0.025em] text-app-ink',
  cardDescription: 'mt-1 mb-0 text-[0.75rem] leading-[1.5] text-sample-muted',
  sectionEyebrow:
    'm-0 text-[0.7rem] font-extrabold tracking-[0.12em] text-sample-muted uppercase',
  primaryButton: classes(
    'inline-flex min-h-10 cursor-pointer items-center justify-center gap-[0.35rem] rounded-full border-0',
    'bg-brand-primary px-4 py-[0.65rem] text-[0.74rem] font-extrabold text-white no-underline hover:bg-[#066538]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46] disabled:cursor-not-allowed disabled:opacity-60',
  ),
  secondaryButton: classes(
    'inline-flex min-h-10 cursor-pointer items-center justify-center gap-[0.35rem] rounded-full border bg-white',
    'border-sample-border px-4 py-[0.65rem] text-[0.74rem] font-bold text-app-ink no-underline',
    'hover:border-[#087f46] hover:text-[#087f46] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f46]',
    'disabled:cursor-not-allowed disabled:opacity-60',
  ),
  dangerButton: classes(
    'inline-flex min-h-10 cursor-pointer items-center justify-center rounded-full border-0 bg-[#9a3947]',
    'px-[0.8rem] py-[0.55rem] text-[0.74rem] font-extrabold text-white hover:bg-[#873140]',
  ),
  quietLink: 'text-[0.74rem] font-bold text-[#087f46] no-underline hover:text-[#066538]',
  mutedLink: 'text-[0.74rem] font-bold text-sample-muted no-underline hover:text-app-ink',
  dangerLink: 'text-[0.74rem] font-bold text-[#9a3947] no-underline hover:text-[#7d2f3a]',
  // 아직 화면이 없는 이동은 링크로 만들지 않고 이 스타일로 "준비 중"임을 보여줍니다.
  pendingLink: 'cursor-default text-[0.74rem] font-bold text-[#838a93]',
  tag: 'inline-flex shrink-0 items-center rounded-full px-[0.6rem] py-[0.25rem] text-[0.68rem] font-extrabold whitespace-nowrap',
  chip: classes(
    'inline-flex min-h-9 items-center gap-[0.35rem] rounded-full border px-[0.78rem] py-[0.4rem]',
    'text-[0.78rem] font-semibold whitespace-nowrap',
  ),
  activeChip: 'border-[#b4ddc7] bg-[#e7f6ed] font-bold text-[#087f46]',
  inactiveChip: 'border-sample-border bg-white text-sample-muted',
  table: 'w-full border-separate border-spacing-0 overflow-hidden rounded-[1.4rem] border border-sample-border text-[0.75rem]',
  tableHeadCell:
    'bg-[#f6f7f8] px-3 py-[0.6rem] text-left text-[0.7rem] font-bold whitespace-nowrap text-app-ink',
  tableCell: 'border-t border-sample-border px-3 py-[0.6rem] align-middle text-sample-muted',
  dangerRow: 'bg-[#fff5f6]',
  pagination: 'flex items-center justify-between gap-3 text-[0.75rem] text-sample-muted',
  emptyNote: 'm-0 text-[0.78rem] leading-[1.6] text-sample-muted',
  toggle:
    'relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 disabled:cursor-not-allowed disabled:opacity-50',
  toggleOn: 'bg-brand-primary',
  toggleOff: 'bg-[#d7dce1]',
  toggleKnob: 'absolute top-[3px] size-4 rounded-full bg-white transition-[left]',
  toggleKnobOn: 'left-[21px]',
  toggleKnobOff: 'left-[3px]',
} as const

const tagTones: Record<WorkspaceTagTone, string> = {
  ok: 'bg-[#e7f6ed] text-[#087f46]',
  warn: 'bg-[#fff4e0] text-[#8a5a00]',
  danger: 'bg-[#fff5f6] text-[#9a3947]',
  muted: 'bg-[#f1f2f3] text-sample-muted',
  info: 'bg-[#e7f6ed] text-[#087f46]',
}

export function workspaceTagClassName(tone: WorkspaceTagTone) {
  return `${workspacePageStyles.tag} ${tagTones[tone]}`
}

export function workspaceChipClassName(isActive: boolean) {
  const variant = isActive ? workspacePageStyles.activeChip : workspacePageStyles.inactiveChip
  return `${workspacePageStyles.chip} ${variant}`
}
