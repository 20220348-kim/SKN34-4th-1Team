import { act, render, screen } from '@testing-library/react-native'
import { SearchProgress } from './SearchProgress'

beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-10-08T03:00:00Z') }) })
afterEach(() => { jest.useRealTimers() })

test('only the confirmed conditions step is done and server steps show their typical durations', () => {
  render(<SearchProgress startedAt={Date.now()} />)
  expect(screen.getByText('✓ 조건 정리')).toBeTruthy()
  expect(screen.getByText('○ 공고 찾기')).toBeTruthy()
  expect(screen.getByText('○ 자격 확인')).toBeTruthy()
  expect(screen.getByText('보통 5초 안팎')).toBeTruthy()
  expect(screen.getByText('보통 20초 안팎')).toBeTruthy()
  expect(screen.queryByText(/지났어요|걸려요/)).toBeNull()
})

test('elapsed time counts from the sent time and the typical duration appears after ten seconds', () => {
  render(<SearchProgress startedAt={Date.now() - 3_000} />)
  expect(screen.getByText('3초 지났어요')).toBeTruthy()
  act(() => { jest.advanceTimersByTime(7_000) })
  expect(screen.getByText('10초 지났어요')).toBeTruthy()
  expect(screen.getByText('후보 공고마다 지원 대상과 지역을 확인하고 있어요. 보통 30초 안팎 걸려요.')).toBeTruthy()
  act(() => { jest.advanceTimersByTime(35_000) })
  expect(screen.getByText('평소보다 오래 걸리고 있어요. 조금만 더 기다려 주세요.')).toBeTruthy()
})

test('without a sent time it shows the steps but never guesses the elapsed time', () => {
  render(<SearchProgress startedAt={null} />)
  act(() => { jest.advanceTimersByTime(30_000) })
  expect(screen.getByText('✓ 조건 정리')).toBeTruthy()
  expect(screen.queryByText(/지났어요|걸려요/)).toBeNull()
})
