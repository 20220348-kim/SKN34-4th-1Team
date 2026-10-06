import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import type { ApplicationProgressStage } from '@govbiz/shared/domain/entities/ApplicationPreparation'

export type SavedProgramFilters = { keyword: string; region: string[]; category: string[]; target: string[] }
export type SavedProgramStageFilter = 'all' | 'interest' | ApplicationProgressStage
export type SavedCalendarMonth = { year: number; month: number }
export type SavedCalendarEvent = { item: SavedSupportProgram; type: 'START' | 'END' | 'SAME_DAY' }
export const firstSavedCalendarYear = 2000
export const lastSavedCalendarYear = 2100
export const savedProgramTargetOptions = ['예비창업자', '창업기업', '중소기업', '소상공인', '기타'] as const
export const emptySavedProgramFilters = (): SavedProgramFilters => ({ keyword: '', region: [], category: [], target: [] })

/** 웹 관심 공고함과 같은 대상 표시 분류입니다. 신청 자격 판정으로 사용하지 않습니다. */
export function savedProgramTarget(description: string) {
  return savedProgramTargetOptions.find(value => value !== '기타' && description.includes(value))
    ?? (description.trim() ? '기타' : '대상 미확인')
}

/** 저장된 공고 안에서 거릅니다. 같은 항목의 선택값은 OR, 서로 다른 항목은 AND입니다. */
export function filterSavedPrograms(items: readonly SavedSupportProgram[], filters: SavedProgramFilters) {
  const keyword = filters.keyword.trim().toLocaleLowerCase('ko-KR')
  return items.filter(({ program }) => (!keyword || `${program.title} ${program.organization}`.toLocaleLowerCase('ko-KR').includes(keyword))
    && (!filters.region.length || program.regions.some(value => filters.region.includes(value)))
    && (!filters.category.length || program.categories.some(value => filters.category.includes(value)))
    && (!filters.target.length || filters.target.includes(savedProgramTarget(program.targetDescription))))
}

/** 웹과 같은 마감일 오름차순이며, 날짜가 없는 공고는 마지막에 표시합니다. */
export function sortSavedProgramsByDeadline(items: readonly SavedSupportProgram[]) {
  return [...items].sort(({ program: left }, { program: right }) => {
    if (left.applicationEndDate === right.applicationEndDate) return left.title.localeCompare(right.title, 'ko-KR')
    if (left.applicationEndDate === null) return 1
    if (right.applicationEndDate === null) return -1
    return left.applicationEndDate < right.applicationEndDate ? -1 : 1
  })
}

export function savedCalendarToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
}

export function savedCalendarMonth(date: string): SavedCalendarMonth {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) }
}

export function moveSavedCalendarMonth(current: SavedCalendarMonth, amount: number): SavedCalendarMonth {
  const date = new Date(Date.UTC(current.year, current.month - 1 + amount, 1))
  return date.getUTCFullYear() < firstSavedCalendarYear || date.getUTCFullYear() > lastSavedCalendarYear ? current
    : { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

/** 접수 시작·마감이 같은 날이면 한 일정으로 표시합니다. 기간 전체를 임의 일정으로 채우지 않습니다. */
export function buildSavedCalendar(current: SavedCalendarMonth, items: readonly SavedSupportProgram[]) {
  const first = new Date(Date.UTC(current.year, current.month - 1, 1))
  const length = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate()
  const monthKey = `${current.year}-${String(current.month).padStart(2, '0')}`
  const grouped = new Map<string, SavedCalendarEvent[]>()
  const add = (date: string | null, event: SavedCalendarEvent) => {
    if (!date?.startsWith(`${monthKey}-`)) return
    grouped.set(date, [...(grouped.get(date) ?? []), event])
  }
  for (const item of items) {
    if (item.program.applicationStartDate !== null && item.program.applicationStartDate === item.program.applicationEndDate) {
      add(item.program.applicationStartDate, { item, type: 'SAME_DAY' })
    } else {
      add(item.program.applicationStartDate, { item, type: 'START' })
      add(item.program.applicationEndDate, { item, type: 'END' })
    }
  }
  const order = { START: 0, SAME_DAY: 1, END: 2 }
  for (const events of grouped.values()) events.sort((left, right) => order[left.type] - order[right.type]
    || left.item.program.title.localeCompare(right.item.program.title, 'ko-KR'))
  return Array.from({ length: Math.ceil((first.getUTCDay() + length) / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(Date.UTC(current.year, current.month - 1, week * 7 + weekday - first.getUTCDay() + 1))
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
      const inMonth = key.startsWith(`${monthKey}-`)
      return { key, day: date.getUTCDate(), inMonth, events: inMonth ? grouped.get(key) ?? [] : [] }
    }))
}
