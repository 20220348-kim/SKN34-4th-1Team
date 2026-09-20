import { useRef, type KeyboardEvent } from 'react'

const searchModeTabLabels = ['AI 대화 검색', '필터 검색'] as const

/**
 * 검색 화면 위의 가로 검색 탭입니다. 검색 화면에서는 아래 패널을 바꾸고, 공고 상세·원문 질문 화면에서는 같은 자리에 남아
 * 누르면 그 검색 화면으로 돌아갑니다. [controlsPanels]가 참일 때만 탭이 패널 id를 가리킵니다.
 */
export function SearchModeTabs({ isFilter, onSelect, controlsPanels = true }: {
  isFilter: boolean
  onSelect: (filter: boolean) => void
  controlsPanels?: boolean
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const handleKey = (event: KeyboardEvent, index: number) => {
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : ['ArrowRight', 'ArrowLeft'].includes(event.key) ? 1 - index : null
    if (target === null) return
    event.preventDefault()
    onSelect(target === 1)
    tabs.current[target]?.focus()
  }

  return <div role="tablist" aria-label="지원사업 검색 방식" aria-orientation="horizontal"
    className="inline-flex gap-1 rounded-full border border-sample-border bg-white p-1">
    {searchModeTabLabels.map((label, index) => <button type="button" key={label} role="tab" id={`search-tab-${index}`}
      ref={(node) => { tabs.current[index] = node }} aria-controls={controlsPanels ? `search-panel-${index}` : undefined}
      aria-selected={isFilter === (index === 1)}
      tabIndex={isFilter === (index === 1) ? 0 : -1} onKeyDown={(event) => handleKey(event, index)} onClick={() => onSelect(index === 1)}
      className={`min-h-10 cursor-pointer rounded-full px-6 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary max-chat:px-5 ${isFilter === (index === 1) ? 'bg-white text-brand-primary shadow-sm' : 'text-sample-muted hover:text-app-ink'}`}>
      {label}
    </button>)}
  </div>
}
