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

// Core `SupportProgramStatusResolver`와 같은 표현 규칙입니다. 낱말 사이 띄어쓰기 변형은 같게 보지만 공백을 모두 지운 뒤
// 찾지 않습니다. 그러면 "100개사 이상 시"의 "이상시"가 "상시"로, "접수 시"가 "수시"로 읽혀 마감 공고가 접수 중이 됩니다.
const conditionMet = '\\s*(?:시(?![간각작행])|될|되면|때)'
const rollingPeriod = new RegExp([
  '(?<![이비평정])상시(?!\\s*(?:근로|종업|고용|인원|직원))',
  '(?<![접인회])수시',
  '선착순',
  '(?:예산|재원|자금|사업비)\\s*(?:조기\\s*)?소진',
  `소진${conditionMet}`,
  `(?:모집|접수|신청|정원|인원|규모)\\s*마감${conditionMet}`,
  `(?:모집|정원|인원)\\s*(?:완료|충족|초과)${conditionMet}`,
].join('|'))
const closedOrUpcomingPeriod = /접수\s*종료|모집\s*종료|마감\s*완료|(?:마감|종료)\s*(?:되었|됐|됨)|추후\s*공지|접수\s*예정/

/**
 * 리포트 항목의 접수 기간은 문자열로만 옵니다. "YYYY-MM-DD ~ YYYY-MM-DD" 꼴이면 접수 상태와 마감까지 남은 날을 계산하고,
 * 상시·예산 소진 시까지·선착순처럼 마감일 없이 받는 표현은 접수 중으로 봅니다. 읽을 수 없으면 null이라 배지를 그리지 않습니다.
 */
export function readReportPeriod(period: string, today: string): ReportPeriod | null {
  const range = /^(\d{4})[-.](\d{2})[-.](\d{2})\s*~\s*(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(period.trim())
  if (!range) {
    const normalized = period.normalize('NFKC').replace(/\s+/g, ' ').trim()
    return rollingPeriod.test(normalized) && !closedOrUpcomingPeriod.test(normalized)
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
