import { useEffect, type ReactNode } from 'react'

/** 토스트가 스스로 닫히기까지의 시간입니다. 되돌리기가 붙는 안내는 8초를 둡니다. */
export const workspaceToastDurationMs = 8_000

const toastStyles = {
  // 흰 카드입니다. PC는 오른쪽 위, 좁은 폭(760px 미만)은 아래 전체 폭.
  region: 'pointer-events-none fixed top-4 right-4 z-[60] flex w-[min(380px,calc(100%_-_2rem))] flex-col gap-2 max-chat:inset-x-3 max-chat:top-auto max-chat:bottom-4 max-chat:w-auto',
  toast: 'pointer-events-auto relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-sample-border bg-white py-3 pr-2 pl-3.5 text-[0.85rem] text-app-ink shadow-[0_14px_34px_rgb(32_33_36_/_14%)]',
  icon: 'shrink-0 text-brand-primary',
  iconDanger: 'shrink-0 text-danger',
  text: 'min-w-0 flex-1 leading-[1.45]',
  close: 'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-sample-muted hover:bg-black/5 hover:text-app-ink focus-visible:outline-2 focus-visible:outline-brand-primary',
  bar: 'absolute bottom-0 left-0 h-[3px] bg-brand-primary motion-safe:animate-[workspace-toast-bar_var(--toast-ms)_linear_forwards]',
} as const

export type WorkspaceToastNotice = { id: number; text: string }

/**
 * 작업 화면 공용 토스트입니다. 담기·빼기처럼 바로 처리한 결과를 알리고, [되돌리기] 같은 동작 하나를 붙일 수 있습니다.
 * `notice.id`가 바뀌면 새 토스트로 보고 시간을 다시 잽니다. 시간이 지나거나 ✕를 누르면 `onClose`가 불립니다.
 * 뒤 화면을 가리지 않고(검은 배경 없음), 흰 카드로만 뜹니다.
 */
export function WorkspaceToast({ notice, tone = 'success', action, durationMs = workspaceToastDurationMs, onClose }: {
  notice: WorkspaceToastNotice | null
  tone?: 'success' | 'danger'
  /** 오른쪽 동작 버튼(예: 되돌리기) 또는 링크 요소입니다. */
  action?: ReactNode
  durationMs?: number
  onClose: () => void
}) {
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(onClose, durationMs)
    return () => clearTimeout(timer)
    // 같은 안내가 다시 오면 id가 바뀌므로 그때만 시간을 다시 잽니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id, durationMs])

  if (notice === null) return null
  return (
    <div className={toastStyles.region}>
      <div className={toastStyles.toast} role={tone === 'danger' ? 'alert' : 'status'} key={notice.id} style={{ '--toast-ms': `${durationMs}ms` } as React.CSSProperties}>
        <svg className={tone === 'danger' ? toastStyles.iconDanger : toastStyles.icon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {tone === 'danger' ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3v.01" /></> : <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></>}
        </svg>
        <span className={toastStyles.text}>{notice.text}</span>
        {action}
        <button type="button" className={toastStyles.close} aria-label="알림 닫기" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        {tone === 'success' ? <span className={toastStyles.bar} aria-hidden="true" /> : null}
      </div>
    </div>
  )
}
