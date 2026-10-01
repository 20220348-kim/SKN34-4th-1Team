export type ReportPeriod = { status: 'OPEN' | 'UPCOMING' | 'CLOSED'; daysLeft: number | null }

/** 서울 기준 오늘 날짜(YYYY-MM-DD)입니다. 리포트 날짜와 접수 마감을 이 날짜와 견줍니다. */
export function reportToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function utcDay(year: string, month: string, day: string): number | null {
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const date = new Date(time)
  // 2월 30일처럼 달력에 없는 날짜는 다음 달로 넘어가므로 되읽어 확인합니다.
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day) ? time : null
}

/**
 * 리포트 항목의 접수 기간은 문자열로만 옵니다. "YYYY-MM-DD ~ YYYY-MM-DD" 꼴이면 접수 상태와 마감까지 남은 날을 계산하고,
 * 상시·예산 소진 시까지는 마감 없는 접수 중으로 봅니다. 읽을 수 없으면 null이라 배지를 그리지 않습니다.
 */
export function readReportPeriod(period: string, today: string): ReportPeriod | null {
  const range = /^(\d{4})[-.](\d{2})[-.](\d{2})\s*~\s*(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(period.trim())
  if (!range) {
    const normalized = period.normalize('NFKC').replace(/\s+/g, '')
    return /예산소진|상시/.test(normalized) && !/접수종료|모집종료|마감완료|접수예정|추후공지/.test(normalized)
      ? { status: 'OPEN', daysLeft: null } : null
  }
  const start = utcDay(range[1], range[2], range[3])
  const end = utcDay(range[4], range[5], range[6])
  const now = Date.parse(today)
  if (start === null || end === null || end < start || Number.isNaN(now)) return null
  if (now < start) return { status: 'UPCOMING', daysLeft: null }
  if (now > end) return { status: 'CLOSED', daysLeft: null }
  return { status: 'OPEN', daysLeft: Math.round((end - now) / 86_400_000) }
}
