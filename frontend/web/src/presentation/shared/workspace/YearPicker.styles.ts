function classes(...groups: string[]) {
  return groups.join(' ')
}

const control = classes(
  'min-h-10 w-full rounded-[0.75rem] border border-sample-border bg-white px-3 text-[0.85rem] text-app-ink',
  'focus:border-[#087f46] focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
  'aria-[invalid=true]:border-[#c9505f]',
)

/** 연도 선택기 스타일입니다. 폼 입력과 같은 높이·테두리를 써서 다른 칸과 나란히 놓입니다. */
export const yearPickerStyles = {
  root: 'min-w-0',
  nativeSelect: classes(control, 'chat:hidden'),
  popoverAnchor: 'relative max-chat:hidden',
  trigger: classes(control, 'flex cursor-pointer items-center justify-between gap-2 text-left'),
  placeholder: 'text-sample-muted',
  caret: 'text-[0.7rem] text-sample-muted',
  popover: classes(
    'z-20 w-[17rem] rounded-[0.9rem] border border-sample-border bg-white p-3',
    'shadow-[0_14px_34px_rgb(32_33_36_/_14%)]',
  ),
  nav: 'mb-2 flex items-center justify-between text-[0.82rem] font-extrabold text-app-ink',
  navButton: classes(
    'size-7 cursor-pointer rounded-[0.5rem] border border-sample-border bg-white text-[0.9rem] font-extrabold text-app-ink',
    'hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:opacity-35',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  ),
  navRange: 'tabular-nums',
  grid: 'grid grid-cols-4 gap-1.5',
  year: classes(
    'min-h-[2.1rem] cursor-pointer rounded-[0.55rem] border border-transparent text-[0.85rem] text-app-ink tabular-nums',
    'hover:bg-brand-accent disabled:cursor-not-allowed disabled:text-[#b8bcc2] disabled:hover:bg-transparent',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  ),
  yearSelected: 'bg-brand-primary font-extrabold text-white hover:bg-brand-primary',
  yearCurrent: 'border-brand-primary font-extrabold text-brand-primary',
  footer: 'mt-2 flex items-center justify-between text-[0.72rem] text-sample-muted',
  footerButton: 'cursor-pointer font-extrabold text-brand-primary hover:underline focus-visible:outline-2 focus-visible:outline-brand-primary',
} as const
