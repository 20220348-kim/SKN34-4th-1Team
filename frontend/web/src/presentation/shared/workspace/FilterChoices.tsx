import { filterChoiceChipClassName, type FilterChoiceOption } from './filterChoiceOptions'

/**
 * 지원사업 검색과 파트너 모집 목록이 함께 쓰는 한 줄 라디오 필터입니다.
 * 빈 값은 "전체"이며, 현재 선택이 목록에 없으면 앞에 붙여 표시합니다.
 */
export function FilterChoices({ label, name, options, selected, onSelect, includeAll = true }: {
  label: string
  name: string
  options: readonly FilterChoiceOption[]
  selected: string
  onSelect: (value: string) => void
  /** 정렬처럼 "전체"가 의미 없는 필터는 끕니다. */
  includeAll?: boolean
}) {
  const known = options.some((option) => option.value === selected)
  const choices = selected && !known ? [{ value: selected, label: selected }, ...options] : [...options]
  const allChoices = includeAll ? [{ value: '', label: '전체' }, ...choices] : choices

  return <fieldset className="m-0 min-w-0 border-0 p-0">
    <legend className="sr-only">{label}</legend>
    <div className="flex gap-3 max-chat:flex-col max-chat:gap-2">
      <span aria-hidden="true" className="w-13 shrink-0 pt-2.5 text-xs font-semibold text-sample-muted max-chat:pt-0">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {allChoices.map((choice) => <label key={choice.value} className="relative min-w-0 max-w-full cursor-pointer">
          <input type="radio" name={name} value={choice.value} aria-label={choice.value ? choice.label : `전체 ${label}`}
            checked={selected === choice.value} onChange={() => onSelect(choice.value)} className="peer sr-only" />
          <span className={filterChoiceChipClassName}>{choice.label}</span>
        </label>)}
      </div>
    </div>
  </fieldset>
}
