import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'

import { useFloatingPopover } from './useFloatingPopover'

const helpTipStyles = {
  root: 'relative inline-flex align-middle',
  button:
    'grid size-5 shrink-0 cursor-help place-items-center rounded-full border border-sample-border bg-white text-[0.68rem] font-extrabold text-sample-muted hover:border-brand-primary hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary',
  tooltip:
    'z-20 flex w-[19rem] max-w-[min(19rem,80vw)] flex-col gap-2 rounded-[0.85rem] border border-sample-border bg-white p-3 text-left text-[0.78rem] font-normal leading-[1.55] text-app-ink shadow-[0_12px_32px_rgb(32_33_36_/_12%)]',
  title: 'm-0 text-[0.72rem] font-extrabold text-sample-muted',
} as const

/**
 * `?` 버튼에 붙는 도움말 말풍선입니다. 마우스를 올리거나 키보드 포커스가 오면 열리고 Esc로 닫히며, 말풍선 위로
 * 마우스를 옮겨도 유지됩니다. 버튼 아래에 띄우되 좌우로 화면을 벗어나면 안쪽으로 옮기고 아래로 넘치는 부분은 안쪽 스크롤로 감추며, 뒤 화면의 배치는 밀지 않습니다.
 * 접근성 이름은 [label]이 맡고, 열린 동안 말풍선(`role="tooltip"`)이 버튼의 설명(`aria-describedby`)이 됩니다.
 */
export function HelpTip({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  const tooltipId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const { reference, floating, floatingStyles } = useFloatingPopover({ open: isOpen, placement: 'bottom-start', gap: 8 })

  useEffect(() => {
    if (!isOpen) return
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isOpen])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setIsOpen(false)
    }
  }

  return (
    <span className={helpTipStyles.root} onMouseEnter={() => setIsOpen(true)} onMouseLeave={() => setIsOpen(false)}>
      <button
        ref={reference}
        className={helpTipStyles.button}
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        aria-describedby={isOpen ? tooltipId : undefined}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleKeyDown}
      >
        ?
      </button>
      {isOpen ? (
        <div id={tooltipId} ref={floating} style={floatingStyles} className={helpTipStyles.tooltip} role="tooltip">
          {title ? <p className={helpTipStyles.title}>{title}</p> : null}
          {children}
        </div>
      ) : null}
    </span>
  )
}
