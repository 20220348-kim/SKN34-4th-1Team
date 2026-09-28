import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'

export type SupportProgramStatusTone = 'open' | 'upcoming' | 'closed' | 'unknown'

/** 접수 상태 한 줄입니다. 점 색으로 상태를 나누고 글자는 사용자 말로 씁니다. */
export function supportProgramStatusLabel(status: SupportProgramStatus): { label: string; tone: SupportProgramStatusTone } {
  switch (status) {
    case 'OPEN':
      return { label: '접수 중', tone: 'open' }
    case 'UPCOMING':
      return { label: '접수 예정', tone: 'upcoming' }
    case 'CLOSED':
      return { label: '접수 마감', tone: 'closed' }
    case 'UNKNOWN':
      return { label: '상태 미확인', tone: 'unknown' }
  }
}

/**
 * 마감까지 남은 날을 `D-3`처럼 줄여 씁니다. 접수 중인 공고에만 붙이고, 마감일이 없거나 이미 지났으면 붙이지 않습니다.
 * 날짜는 `YYYY-MM-DD`이고 서울 기준 오늘과 비교합니다. 3일 이하는 주의 색입니다.
 */
export function supportProgramDeadlineChip(
  status: SupportProgramStatus,
  applicationEndDate: string | null,
  now: Date = new Date(),
): { label: string; urgent: boolean } | null {
  if (status !== 'OPEN' || applicationEndDate === null) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(applicationEndDate)
  if (match === null) return null
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const remaining = Math.round((end - today) / 86_400_000)
  if (remaining < 0) return null
  return { label: remaining === 0 ? 'D-Day' : `D-${remaining}`, urgent: remaining <= 3 }
}
