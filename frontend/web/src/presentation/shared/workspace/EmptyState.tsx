import { type ReactNode, useId } from 'react'
import { Link } from 'react-router'

import { workspaceStateStyles as s } from './WorkspaceStates.styles'

/** 빈 화면의 다음 행동 하나입니다. 다른 화면으로 가면 `to`, 이 화면에서 무언가를 하면 `onClick`을 씁니다. */
export type EmptyStateAction = { label: string; to: string } | { label: string; onClick: () => void }

/**
 * 목록이나 화면이 비었을 때의 안내입니다.
 * 지금 상태(`title`, 예: "관심 공고가 없어요") + 이유나 방법 한 줄(`description`) + 다음 행동 버튼 하나(`action`)를 둡니다.
 * `icon`은 둥근 칸 안에 그리는 장식이라 낭독하지 않습니다. 제목은 기본 h2이고, 이미 h2 아래에 둘 때는 `headingLevel={3}`을 씁니다.
 */
export function EmptyState({ icon, title, description, action, headingLevel = 2 }: {
  icon?: ReactNode
  title: string
  description?: string
  action?: EmptyStateAction
  headingLevel?: 2 | 3
}) {
  const titleId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  return <section className={s.empty} aria-labelledby={titleId}>
    {icon ? <span className={s.emptyIcon} aria-hidden="true">{icon}</span> : null}
    <Heading id={titleId} className={s.emptyTitle}>{title}</Heading>
    {description ? <p className={s.emptyDescription}>{description}</p> : null}
    {action ? 'to' in action
      ? <Link className={s.emptyAction} to={action.to}>{action.label}</Link>
      : <button type="button" className={s.emptyAction} onClick={action.onClick}>{action.label}</button>
      : null}
  </section>
}
