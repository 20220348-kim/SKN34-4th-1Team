import { daysUntil, ddayTone, formatDday, programStatusLabels, type DdayTone } from '@govbiz/shared/domain/labels'

import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'

export type SupportProgramStatusTone = 'open' | 'upcoming' | 'closed' | 'unknown'

const statusTones: Record<SupportProgramStatus, SupportProgramStatusTone> = { OPEN: 'open', UPCOMING: 'upcoming', CLOSED: 'closed', UNKNOWN: 'unknown' }

/** 접수 상태 한 줄입니다. 점 색으로 상태를 나누고 글자는 shared 표시 문구를 씁니다. */
export function supportProgramStatusLabel(status: SupportProgramStatus): { label: string; tone: SupportProgramStatusTone } {
  return { label: programStatusLabels[status], tone: statusTones[status] }
}

/**
 * 마감까지 남은 날을 `D-3`처럼 줄여 씁니다. 접수 중인 공고에만 붙이고, 마감일이 없거나 이미 지났으면 붙이지 않습니다.
 * 날짜는 `YYYY-MM-DD`이고 서울 기준 오늘과 비교합니다. 색 단계는 shared `ddayTone`입니다.
 */
export function supportProgramDeadlineChip(
  status: SupportProgramStatus,
  applicationEndDate: string | null,
  now: Date = new Date(),
): { label: string; tone: DdayTone } | null {
  if (status !== 'OPEN') return null
  const remaining = daysUntil(applicationEndDate, now)
  if (remaining === null || remaining < 0) return null
  return { label: formatDday(remaining), tone: ddayTone(remaining) }
}
