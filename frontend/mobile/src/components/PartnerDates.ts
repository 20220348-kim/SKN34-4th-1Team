/** All deadlines and received dates in the collaboration UI use the Seoul calendar day. */
export function partnerMonthDay(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '날짜 확인 필요'
    : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' })
      .format(date).replace(/\s/g, '').replace(/\.$/, '')
}

export function partnerFullDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '날짜 확인 필요'
}

export function partnerDeadlineDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const parsed = new Date(target)
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)) return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const number = (part: string) => Number(parts.find((item) => item.type === part)?.value)
  const today = Date.UTC(number('year'), number('month') - 1, number('day'))
  return Math.round((target - today) / 86_400_000)
}

export function recruitmentDeadlineLabel(value: string) {
  const days = partnerDeadlineDay(value)
  if (days === null) return '모집 마감일 확인 필요'
  return days < 0 ? '모집 마감' : days === 0 ? '모집 마감 D-day' : `모집 마감 D-${days}`
}

export function recruitmentDeadlineTone(value: string): 'warning' | 'neutral' {
  const days = partnerDeadlineDay(value)
  return days !== null && days >= 0 && days <= 3 ? 'warning' : 'neutral'
}
