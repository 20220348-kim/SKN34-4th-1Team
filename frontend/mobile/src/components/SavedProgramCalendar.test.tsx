import { fireEvent, render, screen } from '@testing-library/react-native'
import { useState } from 'react'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import { programDetail } from '../test/preparationFixtures'
import { SavedProgramCalendar } from './SavedProgramCalendar'
import type { SavedCalendarMonth } from './savedProgramPresentation'

const first: SavedSupportProgram = { savedAt: '2026-10-01', program: { ...programDetail, title: '서울 기술 지원',
  applicationStartDate: '2026-10-05', applicationEndDate: '2026-10-07', matchedReasons: [], recommendationScore: null, eligibilityReview: null } }
const second: SavedSupportProgram = { ...first, program: { ...first.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '부산 창업 지원',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do', applicationEndDate: '2026-10-05' } }

function CalendarHost({ initialMonth }: { initialMonth: SavedCalendarMonth }) {
  const [month, setMonth] = useState(initialMonth)
  return <SavedProgramCalendar items={[first]} month={month} today="2026-10-05" ready loading={false}
    onMonthChange={setMonth} onOpenProgram={jest.fn()} />
}

test('calendar date details preserve both source identities and open only the chosen program', () => {
  const open = jest.fn()
  render(<SavedProgramCalendar items={[first, second]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready loading={false} onMonthChange={jest.fn()} onOpenProgram={open} />)
  fireEvent.press(screen.getByLabelText('2026-10-05 접수 일정 2건 · 오늘'))
  expect(screen.getByText('접수 시작')).toBeTruthy()
  expect(screen.getByText('접수 시작·마감')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('부산 창업 지원 상세 보기'))
  expect(open).toHaveBeenCalledWith({ sourceCode: 'KSTARTUP', sourceProgramId: first.program.id })
}, 15_000)

test('month controls cross year boundaries and today returns to the current Korean month', () => {
  const change = jest.fn()
  render(<SavedProgramCalendar items={[first]} month={{ year: 2026, month: 12 }} today="2026-10-05" ready loading={false} onMonthChange={change} onOpenProgram={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('다음 달'))
  expect(change).toHaveBeenLastCalledWith({ year: 2027, month: 1 })
  fireEvent.press(screen.getByLabelText('오늘'))
  expect(change).toHaveBeenLastCalledWith({ year: 2026, month: 10 })
})

test('calendar chooses a month from the existing native picker', () => {
  const change = jest.fn()
  render(<SavedProgramCalendar items={[first]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready loading={false} onMonthChange={change} onOpenProgram={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('달력 월: 10월'))
  fireEvent.press(screen.getByText('11월'))
  expect(change).toHaveBeenCalledWith({ year: 2026, month: 11 })
})

test.each([2031, 2050, 2100])('calendar directly selects %i from the complete navigation year range', (year) => {
  render(<CalendarHost initialMonth={{ year: 2026, month: 10 }} />)
  fireEvent.press(screen.getByLabelText('달력 연도: 2026년'))
  expect(screen.getAllByRole('radio')).toHaveLength(101)
  expect(screen.getByText('2000년')).toBeTruthy()
  expect(screen.getByText('2100년')).toBeTruthy()
  fireEvent.press(screen.getByText(`${year}년`))
  expect(screen.getByRole('header', { name: `${year}년 10월` })).toBeTruthy()
  expect(screen.getByLabelText(`달력 연도: ${year}년`)).toBeTruthy()
})

test('crossing 2030 keeps all years available and today clears the selected future date', () => {
  render(<CalendarHost initialMonth={{ year: 2030, month: 12 }} />)
  fireEvent.press(screen.getByLabelText('다음 달'))
  expect(screen.getByRole('header', { name: '2031년 1월' })).toBeTruthy()
  fireEvent.press(screen.getByLabelText('달력 연도: 2031년'))
  expect(screen.getAllByRole('radio')).toHaveLength(101)
  expect(screen.getByText('2050년')).toBeTruthy()
  fireEvent.press(screen.getByText('2050년'))
  fireEvent.press(screen.getByLabelText('2050-01-01 접수 일정 0건'))
  expect(screen.getByRole('header', { name: '2050-01-01 접수 일정' })).toBeTruthy()
  fireEvent.press(screen.getByLabelText('오늘'))
  expect(screen.getByRole('header', { name: '2026년 10월' })).toBeTruthy()
  expect(screen.queryByRole('header', { name: '2050-01-01 접수 일정' })).toBeNull()
})

test.each([
  [{ year: 2000, month: 1 }, '이전 달', '다음 달', '2000년 2월'],
  [{ year: 2100, month: 12 }, '다음 달', '이전 달', '2100년 11월'],
] as const)('calendar navigation stops at %j while allowing movement inside the range', (month, disabled, enabled, next) => {
  render(<CalendarHost initialMonth={month} />)
  expect(screen.getByLabelText(disabled)).toBeDisabled()
  fireEvent.press(screen.getByLabelText(disabled))
  expect(screen.getByRole('header', { name: `${month.year}년 ${month.month}월` })).toBeTruthy()
  fireEvent.press(screen.getByLabelText(enabled))
  expect(screen.getByRole('header', { name: next })).toBeTruthy()
})

test('unconfirmed data does not become a zero-event calendar', () => {
  const view = render(<SavedProgramCalendar items={[]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready={false} loading onMonthChange={jest.fn()} onOpenProgram={jest.fn()} />)
  expect(screen.getByLabelText('관심 공고 일정 불러오는 중')).toBeTruthy()
  expect(screen.queryByText(/이달의 접수 일정 0건/)).toBeNull()
  view.rerender(<SavedProgramCalendar items={[]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready={false} loading={false} onMonthChange={jest.fn()} onOpenProgram={jest.fn()} />)
  expect(screen.getByText(/관심 공고 목록을 확인한 뒤/)).toBeTruthy()
  expect(screen.queryByText(/이달의 접수 일정 0건/)).toBeNull()
})
