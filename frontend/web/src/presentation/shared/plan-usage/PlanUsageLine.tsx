import { planUsageStyles as s } from './PlanUsage.styles'
import type { PlanUsageView } from './planUsageView'

/**
 * 기능 하나의 이용량 한 줄입니다(예: "AI 대화 검색 · 오늘 2/10회"). 한도의 80%부터는 경고 색으로 다시 채워지는 때를
 * 함께 두고, 다 쓰면 그 사실과 계속 쓸 수 있는 방법을 알립니다. 실행을 막을지는 쓰는 화면이 정합니다.
 */
export function PlanUsageLine({ view, id, className = 'text-xs' }: {
  view: PlanUsageView
  id?: string
  /** 글자 크기와 여백입니다. 붙는 자리의 안내 글씨에 맞춥니다. */
  className?: string
}) {
  const warn = view.isNearLimit || view.isLimitReached
  return (
    <p id={id} className={`${warn ? s.lineWarning : s.line} ${className}`}>
      {view.isLimitReached ? <span>{view.limitMessage}</span> : <>
        <span>{view.label}</span>
        <span className={s.separator} aria-hidden="true">·</span>
        <span>{view.countText}</span>
        {warn ? <>
          <span className={s.separator} aria-hidden="true">·</span>
          <span>{view.resetText}</span>
        </> : null}
      </>}
    </p>
  )
}
