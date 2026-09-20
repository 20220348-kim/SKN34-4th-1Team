function classes(...groups: string[]) {
  return groups.join(' ')
}

/** 모달 틀 스타일입니다. 폼 안 입력·버튼은 부르는 쪽이 작업 화면 공용 스타일로 그립니다. */
export const workspaceModalStyles = {
  overlay: 'fixed inset-0 z-50 flex items-center justify-center bg-[rgb(32_33_36_/_48%)] p-4',
  overlayBlur: 'backdrop-blur-[6px]',
  dialog: classes(
    'flex w-full max-w-[27.5rem] flex-col gap-4 rounded-[1.1rem] p-6 text-app-ink shadow-[0_24px_60px_rgb(0_0_0_/_28%)]',
    'focus:outline-0',
  ),
  // 바탕색은 톤이 정합니다. 기본·위험은 흰색, 안내(accent)는 옅은 초록 카드입니다.
  dialogDefault: 'bg-white',
  dialogDanger: 'border-t-4 border-[#9a3947] bg-white',
  dialogAccent: 'border border-[#b4ddc7] bg-[#e4f2e9]',
  header: 'flex items-start justify-between gap-3',
  title: 'm-0 text-[1.05rem] font-extrabold',
  description: 'mt-1 mb-0 text-[0.82rem] leading-[1.5] text-sample-muted',
  closeButton: classes(
    'grid size-[1.9rem] shrink-0 cursor-pointer place-items-center rounded-[0.5rem] border border-sample-border bg-white text-[0.8rem] font-extrabold text-sample-muted',
    'hover:text-app-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  ),
  form: 'flex flex-col gap-3',
  field: 'flex min-w-0 flex-col gap-1',
  label: 'text-[0.72rem] font-bold text-sample-muted',
  input: classes(
    'min-h-10 w-full rounded-[0.75rem] border border-sample-border bg-white px-3 text-[0.85rem] text-app-ink',
    'placeholder:text-sample-muted focus:border-[#087f46] focus:shadow-[0_0_0_3px_rgb(8_127_70_/_12%)] focus:outline-0',
    'aria-[invalid=true]:border-[#c9505f]',
  ),
  hint: 'text-[0.72rem] text-sample-muted',
  // 입력하는 동안 규칙 충족·확인 일치를 바로 알려 주는 한 줄입니다. 색만이 아니라 앞의 기호로도 구분합니다.
  hintOk: 'text-[0.72rem] font-bold text-[#087f46]',
  hintBad: 'text-[0.72rem] font-bold text-[#9a3947]',
  error: 'm-0 text-[0.78rem] font-bold text-[#9a3947]',
  consequences: 'rounded-[0.85rem] bg-[#fdecea] px-3 py-2.5 text-[0.8rem] text-app-ink',
  consequenceList: 'mt-1 mb-0 flex flex-col gap-0.5 pl-4',
  actions: 'flex flex-wrap justify-end gap-2 pt-1',
  ghostButton: 'min-h-10 cursor-pointer rounded-full px-4 text-[0.78rem] font-bold text-sample-muted hover:text-app-ink',
  toast: 'm-0 rounded-[0.85rem] bg-[#e7f6ed] px-4 py-3 text-[0.8rem] font-semibold text-[#087f46]',
} as const
