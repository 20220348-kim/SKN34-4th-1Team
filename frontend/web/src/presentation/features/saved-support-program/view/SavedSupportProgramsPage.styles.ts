function classes(...groups: string[]) {
  return groups.join(' ')
}

export const savedSupportProgramStyles = {
  // 파트너 모집 카드와 같은 격자입니다. 폭에 따라 3열·2열·1열로 줄어듭니다.
  cardGrid: 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,max(300px,calc((100%_-_2rem)/3))),1fr))]',
  card: classes(
    'flex flex-col gap-3 rounded-[1.4rem] border border-sample-border bg-white p-5',
    'hover:border-brand-primary/40',
  ),
  cardTop: 'flex flex-wrap items-center gap-2',
  title: 'm-0 text-[1rem] font-bold leading-[1.4] tracking-[-0.02em] text-app-ink',
  titleLink: 'text-app-ink no-underline hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  organization: 'm-0 text-[0.85rem] text-sample-muted',
  meta: 'm-0 mt-auto flex flex-wrap gap-x-3 gap-y-1 text-[0.8rem] text-sample-muted',
  tagRow: 'flex flex-wrap gap-[0.35rem] [&>span]:max-w-full [&>span]:truncate',
  linkRow: 'flex flex-wrap items-center gap-3',
} as const
