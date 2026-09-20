import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react'

import { workspaceModalStyles } from './WorkspaceModal.styles'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 작업 화면들이 함께 쓰는 확인·입력 모달입니다. 열리면 첫 입력에 포커스를 두고 Tab을 안에서 돌리며,
 * Esc·배경 클릭·닫기 버튼으로 닫고 닫힌 뒤에는 열었던 요소로 포커스를 돌려줍니다.
 * 내용과 버튼은 부르는 쪽이 그리고, 여기서는 틀과 접근성만 맡습니다. `tone="danger"`는 되돌릴 수 없는 동작에,
 * `blurBackdrop`은 뒤 화면을 흐리게 가려야 하는 안내에, `tone="accent"`는 안내 카드처럼 옅은 초록 바탕에 씁니다.
 */
export function WorkspaceModal({
  isOpen,
  title,
  description,
  tone = 'default',
  blurBackdrop = false,
  onClose,
  children,
}: {
  isOpen: boolean
  title: string
  description?: string
  tone?: 'default' | 'danger' | 'accent'
  blurBackdrop?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isOpen) return
    openerRef.current = document.activeElement as HTMLElement | null
    // 입력이 있으면 첫 입력에, 없으면 첫 초점 가능 요소(보통 확인 버튼이 아닌 닫기)에 둡니다.
    const firstInput = dialogRef.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    const first = firstInput ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? dialogRef.current)?.focus()
    return () => {
      openerRef.current?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className={`${workspaceModalStyles.overlay} ${blurBackdrop ? workspaceModalStyles.overlayBlur : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        className={`${workspaceModalStyles.dialog} ${tone === 'danger' ? workspaceModalStyles.dialogDanger : tone === 'accent' ? workspaceModalStyles.dialogAccent : workspaceModalStyles.dialogDefault}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className={workspaceModalStyles.header}>
          <div className="min-w-0">
            <h2 id={titleId} className={workspaceModalStyles.title}>{title}</h2>
            {description ? <p id={descriptionId} className={workspaceModalStyles.description}>{description}</p> : null}
          </div>
          <button className={workspaceModalStyles.closeButton} type="button" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
