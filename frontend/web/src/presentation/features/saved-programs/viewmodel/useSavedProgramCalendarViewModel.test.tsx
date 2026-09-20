// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { supportPrograms } from '../../../../data/fixtures/supportPrograms'
import {
  buildCalendarWeeks,
  calendarToday,
  createCalendarPreview,
  defaultSavedProgramCalendarFilters,
  filterCalendarPrograms,
  toCalendarPrograms,
  type CalendarProgram,
} from './savedProgramCalendar'
import { useSavedProgramCalendarViewModel } from './useSavedProgramCalendarViewModel'

afterEach(cleanup)

describe('관심 공고 캘린더', () => {
  it('서버가 계산한 접수 상태를 달력 모델에 보존한다', () => {
    const [program] = toCalendarPrograms([{
      savedAt: '2026-09-10T09:00:00',
      program: { ...supportPrograms[0]!, applicationStartDate: '2099-01-01', applicationEndDate: '2099-12-31', status: 'CLOSED' },
    }])

    expect(program).toMatchObject({ status: 'CLOSED', startDate: '2099-01-01', endDate: '2099-12-31' })
  })

  it('서울 날짜를 사용하고 윤년·요일·6주 달력을 정확히 표시한다', () => {
    expect(calendarToday(new Date('2026-09-09T16:00:00Z'))).toBe('2026-09-10')
    const february = buildCalendarWeeks(2028, 2, '2028-02-29', [])
    expect(february.flat().filter(day => day.inMonth)).toHaveLength(29)
    expect(february.flat().find(day => day.isToday)?.key).toBe('2028-02-29')
    const august = buildCalendarWeeks(2026, 8, '2026-08-01', [])
    expect(august).toHaveLength(6)
    expect(august[0]![0]!.key).toBe('2026-07-26')
    expect(august[5]![6]!.key).toBe('2026-09-05')
  })

  it('한 날짜에 공고가 200개여도 누락하거나 날짜 없는 공고를 끼워 넣지 않는다', () => {
    const programs: CalendarProgram[] = Array.from({ length: 200 }, (_, i) => ({
      id: `${i}`, title: `지원사업 ${i}`, organization: '기관', startDate: null, endDate: '2026-09-11', status: 'OPEN', region: '전국', category: '기술', target: '중소기업',
    }))
    programs.push({ id: 'unknown', title: '날짜 미확인', organization: '기관', startDate: null, endDate: null, status: 'UNKNOWN', region: '전국', category: '기술', target: '중소기업' })
    const days = buildCalendarWeeks(2026, 9, '2026-09-10', programs).flat()
    expect(days.find(day => day.key === '2026-09-11')!.events).toHaveLength(200)
    expect(days.flatMap(day => day.events)).toHaveLength(200)
    expect(programs).toHaveLength(201)
  })

  it('시작일과 마감일을 각각 표시하고 같은 날짜면 당일 일정 하나로 합친다', () => {
    const base = { organization: '기관', region: '전국', category: '기술', target: '중소기업', status: 'OPEN' as const }
    const programs: CalendarProgram[] = [
      { ...base, id: 'period', title: '기간 공고', startDate: '2026-09-03', endDate: '2026-09-11' },
      { ...base, id: 'same', title: '당일 공고', startDate: '2026-09-05', endDate: '2026-09-05' },
      { ...base, id: 'start-only', title: '시작만 있는 공고', startDate: '2026-09-07', endDate: null },
    ]
    const days = buildCalendarWeeks(2026, 9, '2026-09-10', programs).flat()
    expect(days.find(day => day.key === '2026-09-03')!.events.map(event => event.type)).toEqual(['START'])
    expect(days.find(day => day.key === '2026-09-11')!.events.map(event => event.type)).toEqual(['END'])
    expect(days.find(day => day.key === '2026-09-05')!.events.map(event => event.type)).toEqual(['SAME_DAY'])
    expect(days.find(day => day.key === '2026-09-07')!.events.map(event => event.type)).toEqual(['START'])
  })

  it('검색어·지역·분야·지원 대상 조건을 함께 적용한다', () => {
    const programs = createCalendarPreview('2026-09-10')
    expect(filterCalendarPrograms(programs, { ...defaultSavedProgramCalendarFilters, keyword: '서울경제' })).toHaveLength(8)
    expect(filterCalendarPrograms(programs, { ...defaultSavedProgramCalendarFilters, region: '서울', category: '사업화', target: '창업기업' })).toHaveLength(4)
  })

  it('연도·월 이동, 직접 선택, 오늘 복귀와 범위를 처리한다', () => {
    const today = '2026-12-10'
    const { result } = renderHook(() => useSavedProgramCalendarViewModel({ today, programs: createCalendarPreview(today) }))
    act(() => result.current.moveMonth(1))
    expect([result.current.year, result.current.month]).toEqual([2027, 1])
    expect(result.current.programsInMonth).toBe(0)
    act(() => result.current.moveMonth(-12))
    expect([result.current.year, result.current.month]).toEqual([2026, 1])
    act(() => result.current.chooseMonth(2028, 2))
    expect(result.current.weeks.flat().filter(day => day.inMonth)).toHaveLength(29)
    act(() => result.current.goToToday())
    expect([result.current.year, result.current.month]).toEqual([2026, 12])
    expect(result.current.programsInMonth).toBe(24)
    act(() => result.current.chooseMonth(2000, 1))
    expect(result.current.canPreviousMonth).toBe(false)
    expect(result.current.canPreviousYear).toBe(false)
    act(() => result.current.moveMonth(-1))
    expect(result.current.year).toBe(2000)
    act(() => result.current.chooseMonth(2100, 12))
    expect(result.current.canNextMonth).toBe(false)
    expect(result.current.canNextYear).toBe(false)
  })

  it('달력과 목록을 전환하고 목록을 8개씩 페이지로 나눈다', () => {
    const today = '2026-09-10'
    const { result } = renderHook(() => useSavedProgramCalendarViewModel({ today, programs: createCalendarPreview(today) }))
    expect(result.current.viewMode).toBe('calendar')
    expect(result.current.listPrograms).toHaveLength(8)
    expect(result.current.listTotalPages).toBe(3)
    act(() => result.current.setViewMode('list'))
    act(() => result.current.chooseListPage(2))
    expect(result.current.viewMode).toBe('list')
    expect(result.current.listPage).toBe(2)
    act(() => result.current.changeFilter('category', '사업화'))
    expect(result.current.listPage).toBe(1)
    expect(result.current.filteredProgramCount).toBe(4)
    expect(result.current.listTotalPages).toBe(1)
  })
})
