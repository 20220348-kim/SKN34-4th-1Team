import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'

import type { FilterChoiceOption } from './filterChoiceOptions'
import { useFloatingPopover } from './useFloatingPopover'

const styles = {
  trigger: 'inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-white px-3.5 text-[0.85rem] font-semibold text-ink hover:border-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary aria-expanded:border-brand-primary',
  triggerActive: 'border-brand-line bg-brand-soft text-brand-primary',
  count: 'inline-flex min-w-5 items-center justify-center rounded-full bg-brand-primary px-1.5 text-[0.68rem] font-extrabold text-white',
  caret: 'text-[0.7rem] text-ink-muted',
  value: 'min-w-0 flex-1 truncate text-left',
  // 펼침 목록입니다. 여섯 줄 남짓 보이고 나머지는 안에서 스크롤합니다.
  popover: 'z-40 flex flex-col gap-0.5 rounded-xl border border-line bg-white p-1.5 shadow-[0_12px_32px_rgb(32_33_36_/_14%)] outline-0',
  // 체크 상자 없이 고른 줄은 연한 초록 바탕과 굵은 글자로만 표시합니다.
  option: 'flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-sm text-ink hover:bg-surface-muted has-[:checked]:bg-brand-soft has-[:checked]:font-bold has-[:checked]:text-brand-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-primary',
  checkbox: 'sr-only',
  divider: 'my-0.5 h-px bg-line',
} as const

const rowPx = 36
const visibleRows = 7

/**
 * 여러 값을 고르는 드롭다운 필터입니다. 버튼에는 이름과 고른 개수가 보이고, 펼치면 목록이 스크롤 안에서 열립니다.
 * 고른 줄은 체크 상자 대신 배경색으로만 표시합니다(입력 요소는 화면 낭독용으로 숨겨 둡니다).
 * 아무것도 고르지 않은 상태가 "전체"이고, 전체를 누르면 고른 값을 모두 지웁니다. 고르는 동안 목록은 닫히지 않습니다.
 * 칸 위에 이름표를 따로 두는 화면은 `valueText`로 버튼에 이름 대신 고른 값을 보여 줍니다(접근성 이름은 그대로 `label`).
 */
export function MultiSelectField({ label, valueText, options, selected, onToggle, onClearAll, className = '' }: {
  label: string
  /** 버튼에 이름 대신 보일 글자입니다. 주면 개수 배지는 두지 않습니다. */
  valueText?: string
  options: readonly FilterChoiceOption[]
  selected: readonly string[]
  onToggle: (value: string) => void
  onClearAll: () => void
  className?: string
}) {
  const listId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { reference, floating, floatingStyles } = useFloatingPopover({
    open: isOpen, placement: 'bottom-start', gap: 4, matchReferenceWidth: 'min', maxHeight: rowPx * visibleRows + 12,
  })
  const isAll = selected.length === 0

  function close() {
    setIsOpen(false)
  }

  useEffect(() => {
    if (!isOpen) return
    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', closeOnOutside)
    return () => document.removeEventListener('mousedown', closeOnOutside)
  }, [isOpen])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(); triggerRef.current?.focus() }
  }

  return (
    <>
      <button
        ref={(node) => { triggerRef.current = node; reference(node) }}
        type="button"
        className={`${styles.trigger} ${isAll ? '' : styles.triggerActive} ${className}`}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleKeyDown}
      >
        {valueText === undefined ? <span>{label}</span> : <span className={styles.value}>{valueText}</span>}
        {isAll || valueText !== undefined ? null : <span className={styles.count} aria-label={`${selected.length}개 선택`}>{selected.length}</span>}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {isOpen ? (
        <div
          ref={(node) => { listRef.current = node; floating(node) }}
          id={listId}
          role="group"
          aria-label={label}
          style={floatingStyles}
          className={styles.popover}
          onKeyDown={handleKeyDown}
        >
          <label className={styles.option}>
            <input type="checkbox" className={styles.checkbox} aria-label={`전체 ${label}`} checked={isAll} onChange={onClearAll} />
            전체
          </label>
          <span className={styles.divider} aria-hidden="true" />
          {options.map((option) => (
            <label key={option.value} className={styles.option}>
              <input type="checkbox" className={styles.checkbox} aria-label={option.label} checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </>
  )
}
