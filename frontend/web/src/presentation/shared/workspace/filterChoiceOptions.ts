export type FilterChoiceOption = { value: string; label: string }

/** 단일·복수 선택 필터가 함께 쓰는 선택지 칩 모양입니다. 숨긴 input(`peer`)의 선택·포커스 상태를 따라갑니다. */
export const filterChoiceChipClassName =
  'flex min-h-9 items-center justify-center rounded-lg border border-sample-border bg-white px-2.5 text-xs leading-relaxed text-sample-muted transition-colors [overflow-wrap:anywhere] hover:border-brand-primary hover:text-brand-primary peer-checked:border-brand-primary peer-checked:bg-brand-primary peer-checked:font-bold peer-checked:text-white peer-checked:hover:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-primary motion-reduce:transition-none'

/** 값과 표시가 같은 목록(지역·분야)을 FilterChoices 선택지로 바꿉니다. */
export function toFilterChoiceOptions(values: readonly string[]): FilterChoiceOption[] {
  return values.map((value) => ({ value, label: value }))
}
