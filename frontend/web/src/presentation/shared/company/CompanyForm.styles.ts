function classes(...groups: string[]) {
  return groups.join(' ')
}

/**
 * 기업 등록 폼(사업자번호 조회·조회 결과·기본정보 입력)의 스타일입니다. 프로필과 온보딩 2단계가 같은 모양을 씁니다.
 * 조회 결과 카드는 사업자 상태에 따라 바탕색이 달라집니다. 계속은 연한 초록, 휴업은 노란빛, 폐업은 붉은빛.
 */
export const companyFormStyles = {
  form: 'flex flex-col gap-3',
  formGrid: 'grid grid-cols-1 gap-4 @min-[32rem]/column:grid-cols-2',
  formField: 'flex min-w-0 flex-col gap-1.5',
  formFieldWide: '@min-[32rem]/column:col-span-2',
  formLabel: 'flex items-center gap-1 text-[0.8125rem] font-semibold text-ink-muted',
  optionalMark: 'font-medium text-ink-subtle',
  formLabelRequired: "after:ml-0.5 after:font-semibold after:text-danger after:content-['*']",
  input: classes(
    'min-h-11 w-full rounded-[0.75rem] border border-line-strong bg-white px-3.5 text-[0.9375rem] text-app-ink',
    'placeholder:text-ink-subtle focus:border-brand-primary focus:shadow-focus focus:outline-0',
    'aria-[invalid=true]:border-danger max-[599px]:min-h-12 max-[599px]:text-base',
  ),
  lookupRow: 'flex flex-wrap items-end gap-2 [&>label]:min-w-[14rem] [&>label]:flex-1',
  lookupResult: 'flex items-center gap-3.5 rounded-[14px] px-[18px] py-4',
  lookupResultOk: 'bg-brand-soft',
  lookupResultWarn: 'bg-warning-soft',
  lookupResultDanger: 'bg-danger-soft',
  lookupIcon: 'grid size-9 shrink-0 place-items-center rounded-full bg-white',
  lookupIconOk: 'text-brand-primary',
  lookupIconWarn: 'text-warning',
  lookupIconDanger: 'text-danger',
  lookupBody: 'flex min-w-0 flex-1 flex-col gap-0.5',
  lookupHeadline: 'flex flex-wrap items-center gap-2',
  lookupName: 'text-[1rem] font-bold text-app-ink',
  lookupDetail: 'text-[0.8125rem] text-ink-muted',
  lookupNote: 'text-[0.8125rem] leading-[1.55] text-app-ink',
  formError: 'm-0 text-[0.8125rem] font-semibold text-danger',
  formHint: 'text-[0.75rem] text-ink-muted',
  formActions: 'flex flex-wrap justify-end gap-2',
  // 좁은 화면에서 선택 항목(홈페이지)을 접어 두는 토글입니다. 넓은 화면에서는 보이지 않습니다.
  optionalToggle: 'hidden min-h-11 cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-[0.9375rem] font-semibold text-ink-muted max-[599px]:flex',
  optionalHiddenOnCompact: 'max-[599px]:hidden',
} as const
