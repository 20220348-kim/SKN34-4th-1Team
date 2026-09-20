import { filterChoiceChipClassName, type FilterChoiceOption } from './filterChoiceOptions'

/**
 * 여러 값을 함께 고르는 한 줄 체크박스 필터입니다. 파트너 모집 목록의 찾는 역할·지역이 씁니다.
 * 아무것도 고르지 않은 상태가 "전체"이며, 전체를 누르면 고른 값을 모두 지웁니다.
 */
export function FilterMultiChoices({ label, name, options, selected, onToggle, onClearAll }: {
  label: string
  name: string
  options: readonly FilterChoiceOption[]
  selected: readonly string[]
  onToggle: (value: string) => void
  onClearAll: () => void
}) {
  const isAll = selected.length === 0

  return <fieldset className="m-0 min-w-0 border-0 p-0">
    <legend className="sr-only">{label}</legend>
    <div className="flex gap-3 max-chat:flex-col max-chat:gap-2">
      <span aria-hidden="true" className="w-13 shrink-0 pt-2.5 text-xs font-semibold text-sample-muted max-chat:pt-0">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <label className="relative min-w-0 max-w-full cursor-pointer">
          <input type="checkbox" name={name} value="" aria-label={`전체 ${label}`} checked={isAll} onChange={onClearAll} className="peer sr-only" />
          <span className={filterChoiceChipClassName}>전체</span>
        </label>
        {options.map((choice) => <label key={choice.value} className="relative min-w-0 max-w-full cursor-pointer">
          <input type="checkbox" name={name} value={choice.value} aria-label={choice.label}
            checked={selected.includes(choice.value)} onChange={() => onToggle(choice.value)} className="peer sr-only" />
          <span className={filterChoiceChipClassName}>{choice.label}</span>
        </label>)}
      </div>
    </div>
  </fieldset>
}
