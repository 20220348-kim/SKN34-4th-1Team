/**
 * 목록 카드 오른쪽 위의 삭제 버튼입니다. 신청 문서 작성 · 중복 검토 목록이 함께 씁니다.
 * 카드의 동작이 둘뿐이라 [⋯] 메뉴에 숨기지 않고 보이게 두되, 주 동작과 떨어진 자리에 옅은 아이콘으로 두고 누르면 확인 창을 엽니다.
 */
export function CardDeleteButton({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
    className="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted">
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  </button>
}
