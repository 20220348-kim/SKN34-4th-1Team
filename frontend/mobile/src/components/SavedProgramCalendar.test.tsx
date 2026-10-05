import { fireEvent, render, screen } from '@testing-library/react-native'
import type { SavedSupportProgram } from '@govbiz/shared/domain/entities/SavedSupportProgram'
import { programDetail } from '../test/preparationFixtures'
import { SavedProgramCalendar } from './SavedProgramCalendar'

const first: SavedSupportProgram = { savedAt: '2026-10-01', program: { ...programDetail, title: '서울 기술 지원',
  applicationStartDate: '2026-10-05', applicationEndDate: '2026-10-07', matchedReasons: [], recommendationScore: null, eligibilityReview: null } }
const second: SavedSupportProgram = { ...first, program: { ...first.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '부산 창업 지원',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do', applicationEndDate: '2026-10-05' } }

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

test('unconfirmed data does not become a zero-event calendar', () => {
  const view = render(<SavedProgramCalendar items={[]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready={false} loading onMonthChange={jest.fn()} onOpenProgram={jest.fn()} />)
  expect(screen.getByLabelText('관심 공고 일정 불러오는 중')).toBeTruthy()
  expect(screen.queryByText(/이달의 접수 일정 0건/)).toBeNull()
  view.rerender(<SavedProgramCalendar items={[]} month={{ year: 2026, month: 10 }} today="2026-10-05" ready={false} loading={false} onMonthChange={jest.fn()} onOpenProgram={jest.fn()} />)
  expect(screen.getByText(/관심 공고 목록을 확인한 뒤/)).toBeTruthy()
  expect(screen.queryByText(/이달의 접수 일정 0건/)).toBeNull()
})
