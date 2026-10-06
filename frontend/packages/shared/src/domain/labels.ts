import type { ApplicationProgressStage } from './entities/ApplicationPreparation'
import type { SupportProgramStatus } from './entities/SupportProgram'

/**
 * 웹·모바일이 함께 쓰는 표시 문구입니다. 같은 대상은 화면마다 같은 이름으로 보이도록
 * 상태·단계·날짜 문구를 이 한 곳에서만 정의합니다.
 */

/** 공고 접수 상태의 화면 이름입니다. "접수 종료", "마감", "상태 미확인"은 쓰지 않습니다. */
export const programStatusLabels: Record<SupportProgramStatus, string> = {
  OPEN: '접수 중',
  UPCOMING: '접수 예정',
  CLOSED: '접수 마감',
  UNKNOWN: '상태 확인 필요',
}

/** 신청 진행 단계의 화면 이름입니다. "지원 완료", "탈락"은 쓰지 않습니다. */
export const applicationProgressStageLabels: Record<ApplicationProgressStage, string> = {
  PREPARING: '준비 중',
  APPLIED: '제출 완료',
  DOCUMENT_REVIEW: '서류 심사',
  PRESENTATION_REVIEW: '발표 심사',
  SELECTED: '선정',
  REJECTED: '미선정',
}

const dayMs = 86_400_000
const seoulDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })

/** 서울 기준 그 시각의 달력 날짜(YYYY-MM-DD)입니다. */
function seoulDate(value: Date): string {
  return seoulDateFormat.format(value)
}

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD`를 UTC 자정 시각으로 읽습니다. 형식이 다르거나 없는 날짜(2월 30일 등)면 null입니다. */
function calendarDay(value: string): number | null {
  const match = isoDate.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const time = Date.UTC(year, month - 1, day)
  const date = new Date(time)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : null
}

/**
 * 서울 기준 오늘부터 날짜(`YYYY-MM-DD`)까지 남은 날입니다. 오늘이면 0, 지났으면 음수, 읽을 수 없으면 null입니다.
 * 마감일의 D-day는 `formatDday(daysUntil(endDate))`로 씁니다.
 */
export function daysUntil(date: string | null | undefined, now: Date = new Date()): number | null {
  if (!date) return null
  const target = calendarDay(date)
  const today = calendarDay(seoulDate(now))
  return target === null || today === null ? null : Math.round((target - today) / dayMs)
}

/** 마감까지 남은 날을 "D-3", 마감일 당일은 "오늘 마감", 지났으면 "마감"으로 씁니다. "D-Day", "D-0"은 쓰지 않습니다. */
export function formatDday(daysLeft: number): string {
  if (daysLeft < 0) return '마감'
  return daysLeft === 0 ? '오늘 마감' : `D-${daysLeft}`
}

/** D-day 표시의 색 단계입니다. 웹·모바일이 이 단계를 각자의 빨강 · 노랑 · 초록 · 회색에 대응합니다. */
export type DdayTone = 'urgent' | 'soon' | 'later' | 'closed'

/** 마감 7일 이내(당일 포함)는 urgent(빨강), 30일 이내는 soon(노랑), 그 뒤는 later(초록), 이미 지났으면 closed(회색)입니다. */
export function ddayTone(daysLeft: number): DdayTone {
  if (daysLeft < 0) return 'closed'
  if (daysLeft <= 7) return 'urgent'
  return daysLeft <= 30 ? 'soon' : 'later'
}

/**
 * 날짜를 "2026.10.02"로 씁니다. `YYYY-MM-DD`는 그 달력 날짜 그대로, 시각(ISO 문자열·Date)은 서울 날짜로 바꿉니다.
 * `omitCurrentYear`를 켜면 올해 날짜만 "10.02"로 줄입니다. 읽을 수 없는 문자열은 그대로 돌려줍니다.
 */
export function formatDate(value: string | Date, options: { omitCurrentYear?: boolean; now?: Date } = {}): string {
  let date: string | null
  // 날짜만 있는 값은 달력 날짜 그대로 씁니다. 없는 날짜(2월 30일)를 Date가 다음 달로 넘기지 않게 따로 검사합니다.
  if (typeof value === 'string' && isoDate.test(value)) date = calendarDay(value) === null ? null : value
  else {
    const time = typeof value === 'string' ? new Date(value) : value
    date = Number.isNaN(time.getTime()) ? null : seoulDate(time)
  }
  if (date === null) return typeof value === 'string' ? value : ''
  const [year, month, day] = date.split('-')
  const currentYear = seoulDate(options.now ?? new Date()).slice(0, 4)
  return options.omitCurrentYear && year === currentYear ? `${month}.${day}` : `${year}.${month}.${day}`
}
