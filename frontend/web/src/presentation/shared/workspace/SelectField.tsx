import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'

import { useFloatingPopover } from './useFloatingPopover'

export type SelectFieldOption = { value: string; label: string; disabled?: boolean }

const selectFieldStyles = {
  trigger: 'flex cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed',
  triggerLabel: 'min-w-0 flex-1 truncate',
  placeholder: 'text-sample-muted',
  caret: 'shrink-0 text-[0.7rem] text-sample-muted',
  listbox: 'z-40 m-0 list-none rounded-xl border border-sample-border bg-white p-1 shadow-[0_12px_32px_rgb(32_33_36_/_14%)] outline-0',
  option: 'flex min-h-10 cursor-pointer items-center rounded-lg px-3 py-2 text-sm text-app-ink',
  optionActive: 'bg-brand-accent',
  optionSelected: 'font-bold text-brand-primary',
  optionDisabled: 'cursor-not-allowed text-[#b8bcc2]',
} as const

/** 목록 한 줄 높이(40px)입니다. 8줄까지 펼치고 그 이상은 안에서 스크롤합니다. */
export const selectFieldRowPx = 40
export const selectFieldVisibleRows = 8

/**
 * 브라우저 기본 `<select>`를 대신하는 공용 드롭다운입니다. 기본 select는 목록을 운영체제가 그려 창 밖으로 튀어나오고
 * 줄 수도 정할 수 없어서, 버튼(`role="combobox"`) 아래에 우리가 그리는 목록(`role="listbox"`)을 띄웁니다.
 * 목록은 아래로만 펼치고, 8줄까지만 보이며 그 이상과 화면 아래를 넘는 부분은 안쪽 스크롤로 봅니다.
 * 키보드는 위·아래·Home·End로 옮기고 Enter·Space로 고르며 Esc·Tab·바깥 클릭으로 닫습니다. 포커스는 버튼에 머물고
 * 현재 줄은 `aria-activedescendant`로 알립니다. 값·변경 계약은 `<select>`와 같아(`value`·`onChange(value)`) 바꿔 끼우기만 하면 됩니다.
 */
export function SelectField({
  id,
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
  invalid,
  describedBy,
  placeholder = '선택',
  className = '',
}: {
  id?: string
  name?: string
  /** 접근성 이름입니다. `<label htmlFor>`로 이름을 주는 경우 생략합니다. */
  label?: string
  value: string
  options: readonly SelectFieldOption[]
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
  /** 값이 목록에 없을 때(빈 값 등) 버튼에 보일 글자입니다. */
  placeholder?: string
  /** 버튼에 줄 입력칸 스타일입니다. 각 화면의 입력칸 클래스를 그대로 넘깁니다. */
  className?: string
}) {
  const listId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const { reference, floating, floatingStyles } = useFloatingPopover({
    open: isOpen, placement: 'bottom-start', gap: 4, matchReferenceWidth: 'min', maxHeight: selectFieldRowPx * selectFieldVisibleRows + 8,
  })
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function open() {
    if (disabled) return
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled))
    setIsOpen(true)
  }

  function close() {
    setIsOpen(false)
    setActiveIndex(-1)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    close()
    if (option.value !== value) onChange(option.value)
    triggerRef.current?.focus()
  }

  function move(from: number, step: 1 | -1): number {
    let index = from
    for (let i = 0; i < options.length; i += 1) {
      index = (index + step + options.length) % options.length
      if (!options[index]?.disabled) return index
    }
    return from
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open() }
      return
    }
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); setActiveIndex((index) => move(index, 1)); break
      case 'ArrowUp': event.preventDefault(); setActiveIndex((index) => move(index, -1)); break
      case 'Home': event.preventDefault(); setActiveIndex(move(-1, 1)); break
      case 'End': event.preventDefault(); setActiveIndex(move(0, -1)); break
      case 'Enter': case ' ': event.preventDefault(); choose(activeIndex); break
      case 'Escape': event.preventDefault(); close(); break
      case 'Tab': close(); break
    }
  }

  // 바깥을 누르면 닫습니다. 목록 안 클릭은 mousedown에서 기본 동작을 막아 버튼 포커스를 유지합니다.
  useEffect(() => {
    if (!isOpen) return
    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close()
    }
    document.addEventListener('mousedown', closeOnOutside)
    return () => document.removeEventListener('mousedown', closeOnOutside)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [isOpen, activeIndex])

  const activeOptionId = isOpen && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined

  return (
    <>
      <button
        ref={(node) => { triggerRef.current = node; reference(node) }}
        id={id}
        name={name}
        type="button"
        role="combobox"
        className={`${className} ${selectFieldStyles.trigger}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={activeOptionId}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        data-value={value}
        disabled={disabled}
        onClick={() => { if (isOpen) close(); else open() }}
        onKeyDown={handleKeyDown}
      >
        <span className={`${selectFieldStyles.triggerLabel} ${selected ? '' : selectFieldStyles.placeholder}`}>{selected ? selected.label : placeholder}</span>
        <span className={selectFieldStyles.caret} aria-hidden="true">▾</span>
      </button>
      {isOpen ? (
        <ul
          ref={(node) => { listRef.current = node; floating(node) }}
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          style={floatingStyles}
          className={selectFieldStyles.listbox}
          onMouseDown={(event) => event.preventDefault()}
          // 정렬·출처처럼 <label>이 감싸는 경우, 목록 클릭이 label의 기본 동작으로 버튼에 다시 전달돼 목록이 되열리지 않게 막습니다.
          onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled || undefined}
              data-value={option.value}
              className={`${selectFieldStyles.option} ${index === activeIndex ? selectFieldStyles.optionActive : ''} ${index === selectedIndex ? selectFieldStyles.optionSelected : ''} ${option.disabled ? selectFieldStyles.optionDisabled : ''}`}
              onMouseEnter={() => { if (!option.disabled) setActiveIndex(index) }}
              onClick={() => choose(index)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
