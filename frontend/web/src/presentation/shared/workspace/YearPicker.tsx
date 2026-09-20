import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { SelectField } from './SelectField'
import { useFloatingPopover } from './useFloatingPopover'
import { yearPickerStyles } from './YearPicker.styles'

const YEARS_PER_PAGE = 12

/**
 * 설립연도처럼 "연도 하나"를 고르는 입력입니다. 넓은 화면에서는 12년씩 넘기는 격자 선택기를,
 * 좁은 화면에서는 같은 범위의 네이티브 select를 보여 줍니다. `label`은 부르는 쪽의 `<label htmlFor={id}>`가 그리고
 * 여기서는 select에 그 id를 달아 연결합니다. 범위 밖 연도는 잠급니다.
 */
export function YearPicker({
  id,
  label,
  value,
  min,
  max,
  onChange,
  invalid = false,
}: {
  id: string
  label: string
  value: number | null
  min: number
  max: number
  onChange: (year: number) => void
  invalid?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [pageStart, setPageStart] = useState(() => pageStartFor(value ?? max, max))
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // 아래로만 펼치되 오른쪽 공간이 부족하면 왼쪽으로 옮기고, 아래 공간이 부족하면 안에서 스크롤합니다.
  const { reference, floating, floatingStyles } = useFloatingPopover({ open: isOpen, placement: 'bottom-start' })
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const focusYear = value ?? max
    setPageStart(pageStartFor(focusYear, max))
    const timer = window.setTimeout(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-year="${focusYear}"]`)?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [isOpen, value, min, max])

  function close(returnFocus: boolean) {
    setIsOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  // 선택기 바깥을 누를 때만 닫습니다. 안쪽의 글자·여백을 눌러 포커스가 body로 가도 열린 채 둡니다.
  useEffect(() => {
    if (!isOpen) return
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsidePress)
    return () => document.removeEventListener('mousedown', closeOnOutsidePress)
  }, [isOpen])

  function choose(year: number) {
    onChange(year)
    close(true)
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = Number((event.target as HTMLElement).getAttribute('data-year'))
    if (!Number.isFinite(current) || current === 0) return
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4, PageUp: -YEARS_PER_PAGE, PageDown: YEARS_PER_PAGE }
    const step = event.key === 'Home' ? min - current : event.key === 'End' ? max - current : steps[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = Math.min(max, Math.max(min, current + step))
    setPageStart(pageStartFor(next, max))
    window.setTimeout(() => gridRef.current?.querySelector<HTMLButtonElement>(`[data-year="${next}"]`)?.focus(), 0)
  }

  const years = Array.from({ length: YEARS_PER_PAGE }, (_, index) => pageStart + index)
  const pageEnd = pageStart + YEARS_PER_PAGE - 1
  const selectYears = Array.from({ length: max - min + 1 }, (_, index) => max - index)

  return (
    <div
      ref={rootRef}
      className={yearPickerStyles.root}
      onBlur={(event) => {
        // Tab으로 바깥의 다른 요소에 포커스가 옮겨 갈 때만 닫습니다. relatedTarget이 없으면(안쪽 여백 클릭) 유지합니다.
        const next = event.relatedTarget as Node | null
        if (isOpen && next !== null && !rootRef.current?.contains(next)) close(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.preventDefault()
          close(true)
        }
      }}
    >
      {/* 좁은 화면: 공용 드롭다운. label의 htmlFor가 여기에 붙습니다. */}
      <SelectField
        id={id}
        className={yearPickerStyles.nativeSelect}
        invalid={invalid}
        value={value === null ? '' : String(value)}
        options={[{ value: '', label: '선택' }, ...selectYears.map((year) => ({ value: String(year), label: String(year) }))]}
        onChange={(next) => { if (next) onChange(Number(next)) }}
      />

      {/* 넓은 화면: 격자 선택기 */}
      <div className={yearPickerStyles.popoverAnchor}>
        <button
          ref={(node) => { triggerRef.current = node; reference(node) }}
          className={yearPickerStyles.trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-invalid={invalid}
          aria-label={`${label} ${value ?? '선택'}`}
          onClick={() => setIsOpen((open) => !open)}
        >
          <span className={value === null ? yearPickerStyles.placeholder : undefined}>{value ?? '연도 선택'}</span>
          <span className={yearPickerStyles.caret} aria-hidden="true">▾</span>
        </button>

        {isOpen ? (
          <div ref={floating} style={floatingStyles} className={yearPickerStyles.popover} role="dialog" aria-label={`${label} 선택`}>
            <div className={yearPickerStyles.nav}>
              <button
                className={yearPickerStyles.navButton}
                type="button"
                aria-label="이전 12년"
                disabled={pageStart <= min}
                onClick={() => setPageStart(pageStart - YEARS_PER_PAGE)}
              >‹</button>
              <span className={yearPickerStyles.navRange}>{`${pageStart} – ${Math.min(pageEnd, max)}`}</span>
              <button
                className={yearPickerStyles.navButton}
                type="button"
                aria-label="다음 12년"
                disabled={pageEnd >= max}
                onClick={() => setPageStart(pageStart + YEARS_PER_PAGE)}
              >›</button>
            </div>
            <div ref={gridRef} className={yearPickerStyles.grid} onKeyDown={handleGridKeyDown}>
              {years.map((year) => {
                const isOutOfRange = year < min || year > max
                const isSelected = year === value
                return (
                  <button
                    key={year}
                    className={`${yearPickerStyles.year} ${isSelected ? yearPickerStyles.yearSelected : year === max ? yearPickerStyles.yearCurrent : ''}`}
                    type="button"
                    data-year={year}
                    tabIndex={isSelected || (value === null && year === max) ? 0 : -1}
                    aria-pressed={isSelected}
                    disabled={isOutOfRange}
                    onClick={() => choose(year)}
                  >
                    {year}
                  </button>
                )
              })}
            </div>
            <div className={yearPickerStyles.footer}>
              <span>{`${min}년부터 ${max}년까지`}</span>
              <button className={yearPickerStyles.footerButton} type="button" onClick={() => choose(max)}>올해로</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 올해로 끝나는 12년 쪽부터 거꾸로 잘라, 그 연도가 속한 쪽의 첫해입니다. 첫 쪽은 올해 포함 최근 12년입니다. */
function pageStartFor(year: number, max: number): number {
  const lastPageStart = max - YEARS_PER_PAGE + 1
  return lastPageStart - Math.ceil(Math.max(0, lastPageStart - year) / YEARS_PER_PAGE) * YEARS_PER_PAGE
}
