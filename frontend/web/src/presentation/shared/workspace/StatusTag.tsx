import { ddayTone, formatDday, programStatusLabels } from '@govbiz/shared/domain/labels'

import type { SupportProgramStatus } from '../../../domain/entities/SupportProgram'
import { ddayToneClassNames, workspaceStateStyles as s } from './WorkspaceStates.styles'

const statusTones: Record<SupportProgramStatus, string> = {
  OPEN: s.tagBrand,
  UPCOMING: s.tagInfo,
  CLOSED: s.tagNeutral,
  UNKNOWN: s.tagWarning,
}

/**
 * 공고 접수 상태 태그입니다. 글자는 shared 표시 문구(접수 중 · 접수 예정 · 접수 마감 · 상태 확인 필요)입니다.
 * 접수 중이고 마감까지 남은 날(`daysLeft`, shared `daysUntil` 값)이 0 이상이면 옆에 D-day 태그(D-3 · D-day)를 붙입니다.
 * 색은 shared `ddayTone`(7일 이내 빨강 · 30일 이내 노랑 · 그 뒤 초록)입니다. 마감일이 없거나 접수 중이 아니면 D-day를 붙이지 않습니다.
 */
export function StatusTag({ status, daysLeft = null }: { status: SupportProgramStatus; daysLeft?: number | null }) {
  const showDday = status === 'OPEN' && daysLeft !== null && daysLeft >= 0
  return <span className={s.tagRow}>
    <span className={`${s.tag} ${statusTones[status]}`}><span className={s.tagDot} aria-hidden="true" />{programStatusLabels[status]}</span>
    {showDday ? <span className={`${s.tag} ${ddayToneClassNames[ddayTone(daysLeft)]}`}>{formatDday(daysLeft)}</span> : null}
  </span>
}
