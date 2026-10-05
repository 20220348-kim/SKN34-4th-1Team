import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import { programDetail } from '../test/preparationFixtures'
import { buildSavedCalendar, emptySavedProgramFilters, filterSavedPrograms, moveSavedCalendarMonth, savedCalendarToday, savedProgramTarget, sortSavedProgramsByDeadline } from './savedProgramPresentation'

const saved = (id: string, values: Partial<SavedSupportProgram['program']> = {}): SavedSupportProgram => ({ savedAt: '2026-10-01',
  program: { ...programDetail, id, matchedReasons: [], recommendationScore: null, eligibilityReview: null, ...values } })

test('saved criteria search names and institutions, OR values within a group and AND groups', () => {
  const items = [saved('a', { title: '서울 기술', organization: '지원센터', regions: ['서울', '경기'], categories: ['기술'], targetDescription: '중소기업' }),
    saved('b', { title: '부산 창업', organization: '지원센터', regions: ['부산'], categories: ['창업'], targetDescription: '예비창업자' }),
    saved('c', { title: '서울 창업', organization: '다른 기관', regions: ['서울'], categories: ['창업'], targetDescription: '창업기업' })]
  expect(filterSavedPrograms(items, { ...emptySavedProgramFilters(), keyword: ' 지원센터 ', region: ['서울', '부산'], category: ['기술', '창업'], target: ['중소기업', '예비창업자'] })
    .map(item => item.program.id)).toEqual(['a', 'b'])
  expect(filterSavedPrograms(items, { ...emptySavedProgramFilters(), keyword: '서울', region: ['부산'] })).toEqual([])
})

test('target grouping follows the web priority and keeps missing descriptions unclassified', () => {
  expect(savedProgramTarget('창업기업 및 중소기업')).toBe('창업기업')
  expect(savedProgramTarget('지역 주민')).toBe('기타')
  expect(savedProgramTarget(' ')).toBe('대상 미확인')
})

test('deadline order retains all providers, places undated notices last and leaves the input unchanged', () => {
  const items = [saved('same', { title: '날짜 없음' }), saved('same', { sourceCode: 'KSTARTUP', title: '늦은 공고', applicationEndDate: '2026-10-20' }),
    saved('earlier', { title: '이른 공고', applicationEndDate: '2026-10-05' })]
  const result = sortSavedProgramsByDeadline(items)
  expect(result.map(item => item.program.title)).toEqual(['이른 공고', '늦은 공고', '날짜 없음'])
  expect(items[0].program.title).toBe('날짜 없음')
  expect(result).toHaveLength(3)
})

test('Seoul today changes at the Korean midnight rather than UTC midnight', () => {
  expect(savedCalendarToday(new Date('2026-10-04T14:59:59Z'))).toBe('2026-10-04')
  expect(savedCalendarToday(new Date('2026-10-04T15:00:00Z'))).toBe('2026-10-05')
})

test('month navigation crosses years and stops at the web calendar bounds', () => {
  expect(moveSavedCalendarMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
  expect(moveSavedCalendarMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
  expect(moveSavedCalendarMonth({ year: 2000, month: 1 }, -1)).toEqual({ year: 2000, month: 1 })
  expect(moveSavedCalendarMonth({ year: 2100, month: 12 }, 1)).toEqual({ year: 2100, month: 12 })
})

test('calendar records starts, ends and same-day events without inventing dates for undated notices', () => {
  const weeks = buildSavedCalendar({ year: 2026, month: 10 }, [saved('a', { applicationStartDate: '2026-10-05', applicationEndDate: '2026-10-07' }),
    saved('a', { sourceCode: 'KSTARTUP', applicationStartDate: '2026-10-05', applicationEndDate: '2026-10-05' }), saved('undated')])
  expect(weeks.flat().find(day => day.key === '2026-10-05')?.events.map(event => [event.item.program.sourceCode, event.type])).toEqual([
    ['BIZINFO', 'START'], ['KSTARTUP', 'SAME_DAY'],
  ])
  expect(weeks.flat().find(day => day.key === '2026-10-07')?.events[0].type).toBe('END')
  expect(weeks.flat().flatMap(day => day.events)).toHaveLength(3)
})

test('a leap month includes February 29 and keeps next month events outside its cells', () => {
  const days = buildSavedCalendar({ year: 2024, month: 2 }, [saved('a', { applicationStartDate: '2024-02-29', applicationEndDate: '2024-03-01' })]).flat()
  expect(days.find(day => day.key === '2024-02-29')?.events[0].type).toBe('START')
  expect(days.find(day => day.key === '2024-03-01')).toEqual(expect.objectContaining({ inMonth: false, events: [] }))
})
