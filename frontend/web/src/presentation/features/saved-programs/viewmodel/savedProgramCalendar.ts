import type { SavedSupportProgram } from '../../../../domain/entities/SavedSupportProgram'
import type { SupportProgramStatus } from '../../../../domain/entities/SupportProgram'

/** 회원이 저장한 공고를 달력과 목록에 표시하기 위한 화면 모델입니다. */
export type CalendarProgram = {
  id: string
  sourceCode?: string
  sourceProgramId?: string
  title: string
  organization: string
  startDate: string | null
  endDate: string | null
  /** 서버가 계산한 접수 상태입니다. 날짜로 다시 계산하지 않습니다. */
  status: SupportProgramStatus
  region: string
  regionValues?: readonly string[]
  category: string
  categoryValues?: readonly string[]
  target: string
}

export type CalendarEventType = 'START' | 'END' | 'SAME_DAY'

export type CalendarEvent = {
  program: CalendarProgram
  type: CalendarEventType
}

export type SavedProgramCalendarFilters = {
  keyword: string
  region: string
  category: string
  target: string
}

export const defaultSavedProgramCalendarFilters: SavedProgramCalendarFilters = {
  keyword: '', region: '', category: '', target: '',
}

export const savedProgramTargetOptions = ['예비창업자', '창업기업', '중소기업', '소상공인', '기타'] as const

export const firstCalendarYear = 2000
export const lastCalendarYear = 2100

export function toCalendarDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function calendarToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
}

/** Core API가 돌려준 회원별 관심 공고를 달력 화면 모델로 변환합니다. */
export function toCalendarPrograms(savedPrograms: readonly SavedSupportProgram[]): CalendarProgram[] {
  return savedPrograms.map(({ program }) => {
    const target = savedProgramTargetOptions.find((option) => option !== '기타' && program.targetDescription.includes(option))
      ?? (program.targetDescription.trim() ? '기타' : '대상 미확인')
    return {
      id: `${program.sourceCode}:${program.id}`,
      sourceCode: program.sourceCode,
      sourceProgramId: program.id,
      title: program.title,
      organization: program.organization,
      startDate: program.applicationStartDate,
      endDate: program.applicationEndDate,
      status: program.status,
      region: program.regions.join(' · ') || '지역 미분류',
      regionValues: program.regions,
      category: program.categories.join(' · ') || '분야 미분류',
      categoryValues: program.categories,
      target,
    }
  })
}

/** 샘플은 최초 표시 월에만 만듭니다. 월 이동 때 가짜 공고를 계속 생성하지 않습니다. */
export function createCalendarPreview(today: string): CalendarProgram[] {
  const names = ['AI 사업화 지원', '수출 바우처 지원사업', '스마트공장 구축 지원', '초기 창업기업 성장 지원', '중소기업 기술개발 지원', '해외 전시회 참가 지원']
  const organizations = ['서울경제진흥원', '중소벤처기업부', '중소벤처기업진흥공단']
  const regions = ['서울', '전국', '경기', '부산', '대전', '전국']
  const categories = ['사업화', '수출', '기술', '창업', '기술개발(R&D)', '판로ㆍ해외진출']
  const targets = ['창업기업', '중소기업', '중소기업', '예비창업자', '중소기업', '창업기업']
  const month = today.slice(0, 7)
  const day = Number(today.slice(8))
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()
  const crowdedDay = Math.min(day + 1, lastDay)
  return Array.from({ length: 24 }, (_, index) => {
    const endDay = index < 9 ? crowdedDay : [3, 7, day, 15, 20, 24, 27][index % 7]!
    const startDay = index % 8 === 0 ? endDay : Math.max(1, endDay - (index % 4 + 1))
    return {
      id: `calendar-preview-${index + 1}`,
      title: `${names[index % names.length]}${index >= 6 ? ` · ${index + 1}차` : ''}`,
      organization: organizations[index % organizations.length]!,
      startDate: `${month}-${String(startDay).padStart(2, '0')}`,
      endDate: `${month}-${String(endDay).padStart(2, '0')}`,
      status: 'OPEN',
      region: regions[index % regions.length]!,
      category: categories[index % categories.length]!,
      target: targets[index % targets.length]!,
    }
  })
}

export function filterCalendarPrograms(
  programs: readonly CalendarProgram[],
  filters: SavedProgramCalendarFilters,
): CalendarProgram[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase('ko-KR')
  return programs.filter((program) => {
    if (keyword && !`${program.title} ${program.organization}`.toLocaleLowerCase('ko-KR').includes(keyword)) return false
    if (filters.region && !(program.regionValues ?? [program.region]).includes(filters.region)) return false
    if (filters.category && !(program.categoryValues ?? [program.category]).includes(filters.category)) return false
    if (filters.target && program.target !== filters.target) return false
    return true
  })
}

export function buildCalendarWeeks(year: number, month: number, today: string, programs: readonly CalendarProgram[]) {
  const start = new Date(Date.UTC(year, month - 1, 1))
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthKey = `${year}-${String(month).padStart(2, '0')}`
  const grouped = new Map<string, CalendarEvent[]>()
  for (const program of programs) {
    if (program.startDate !== null && program.startDate === program.endDate) {
      addCalendarEvent(grouped, monthKey, program.startDate, { program, type: 'SAME_DAY' })
      continue
    }
    if (program.startDate !== null) addCalendarEvent(grouped, monthKey, program.startDate, { program, type: 'START' })
    if (program.endDate !== null) addCalendarEvent(grouped, monthKey, program.endDate, { program, type: 'END' })
  }
  for (const events of grouped.values()) events.sort(compareCalendarEvents)
  return Array.from({ length: Math.ceil((start.getUTCDay() + length) / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(Date.UTC(year, month - 1, week * 7 + weekday - start.getUTCDay() + 1))
      const key = toCalendarDate(date)
      const inMonth = key.startsWith(`${monthKey}-`)
      return { key, day: date.getUTCDate(), inMonth, isToday: key === today, events: inMonth ? grouped.get(key) ?? [] : [] }
    }),
  )
}

function addCalendarEvent(
  grouped: Map<string, CalendarEvent[]>,
  monthKey: string,
  date: string,
  event: CalendarEvent,
) {
  if (!date.startsWith(`${monthKey}-`)) return
  const entries = grouped.get(date) ?? []
  entries.push(event)
  grouped.set(date, entries)
}

function compareCalendarEvents(left: CalendarEvent, right: CalendarEvent): number {
  const order: Record<CalendarEventType, number> = { START: 0, SAME_DAY: 1, END: 2 }
  return order[left.type] - order[right.type] || left.program.title.localeCompare(right.program.title, 'ko-KR')
}
