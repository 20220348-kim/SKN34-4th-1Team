import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react'

import { appSidebarStyles } from '../app-sidebar/AppSidebar.styles'
import { useResetScrollOnNavigate } from '../routes/useResetScrollOnNavigate'
import { InChatSheetContext } from './useChatSheet'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const iconButton = 'grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary'

/**
 * 대화 위에 띄우는 큰 시트입니다. 데스크톱은 위·양옆으로 뒤의 대화가 비치게 화면 대부분을 덮고, 600px 미만은 화면 전체를 덮습니다.
 * 머리에는 화면 종류와 [전체 화면으로 열기] · [닫기]만 두고, 안의 화면은 작업 화면을 그대로 그립니다(스크롤은 시트 안 칸이 맡음).
 * Esc · 바깥 누르기 · [닫기]로 닫고, 열 때 시트에, 닫으면 연 요소로 포커스를 돌려줍니다. 안에서 연 확인 모달이 먼저 Esc · Tab을 받습니다.
 */
export function ChatSheet({ kind, onClose, onExpand, children }: {
  kind: string; onClose: () => void; onExpand: () => void; children: ReactNode
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 시트 안에서 다른 화면으로 옮기면 시트 칸을 맨 위로 돌립니다(뒤의 대화 스크롤은 그대로).
  useResetScrollOnNavigate(bodyRef)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(32_33_36_/_48%)] min-[600px]:px-6 min-[600px]:pt-[4vh]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}
        className="flex h-full w-full max-w-[1080px] min-w-0 flex-col overflow-hidden bg-white shadow-[0_24px_60px_rgb(0_0_0_/_28%)] focus:outline-0 min-[600px]:rounded-t-[1.1rem]">
        <div className="flex shrink-0 items-center gap-1 border-b border-line py-1.5 pr-2 pl-4">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-sm font-bold text-ink">{kind}</h2>
          <button type="button" className={iconButton} onClick={onExpand} aria-label="전체 화면으로 열기" title="전체 화면으로 열기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          <button type="button" className={iconButton} onClick={onClose} aria-label="닫기" title="닫기">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <InChatSheetContext.Provider value>
          <div ref={bodyRef} className={`${appSidebarStyles.workspace} overscroll-contain`}>{children}</div>
        </InChatSheetContext.Provider>
      </div>
    </div>
  )
}
