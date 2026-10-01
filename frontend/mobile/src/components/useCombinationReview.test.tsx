import { act, renderHook, waitFor } from '@testing-library/react-native'
import { AppState } from 'react-native'
import { useCombinationReview } from './useCombinationReview'
import { mobileReview, reviewRunFixture } from '../test/reviewFixtures'

const mockRepository = { get: jest.fn(), runs: jest.fn(), run: jest.fn(), create: jest.fn(), replace: jest.fn(), start: jest.fn() }
const mockInvalidate = jest.fn()
jest.mock('../auth/session', () => ({ useAuth: () => ({ invalidateSession: mockInvalidate }) }))
jest.mock('../api/client', () => ({ getApiBaseUrl: () => 'https://api.example.test' }))
jest.mock('../api/combinationReviews', () => ({ MobileCombinationReviewRepository: jest.fn().mockImplementation(() => mockRepository), reviewErrorMessage: () => '조회 오류' }))
jest.mock('../auth/reviewPending', () => ({ readPendingReview: jest.fn(async () => null), clearPendingReview: jest.fn(), savePendingReview: jest.fn() }))
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return { useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }
})
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }))

beforeEach(() => {
  for (const method of Object.values(mockRepository)) method.mockReset()
  mockRepository.get.mockResolvedValue(mobileReview)
  mockRepository.runs.mockResolvedValue({ items: [reviewRunFixture()], nextBeforeId: null })
  mockRepository.run.mockResolvedValue(reviewRunFixture())
})
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

test('polling uses GET only, pauses in the background and resumes without a new AI request', async () => {
  jest.useFakeTimers()
  let change!: (value: string) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    change = listener as (value: string) => void
    return { remove: jest.fn() }
  })
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.run?.status).toBe('QUEUED'))
  const initialReads = mockRepository.run.mock.calls.length
  await act(async () => { await jest.advanceTimersByTimeAsync(3_000) })
  expect(mockRepository.run.mock.calls.length).toBe(initialReads + 1)
  await act(async () => change('background'))
  const backgroundReads = mockRepository.run.mock.calls.length
  await act(async () => { await jest.advanceTimersByTimeAsync(9_000) })
  expect(mockRepository.run).toHaveBeenCalledTimes(backgroundReads)
  await act(async () => change('active'))
  await waitFor(() => expect(mockRepository.get.mock.calls.length).toBeGreaterThan(1))
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(mockRepository.create).not.toHaveBeenCalled()
  view.unmount()
})

test('completed states are not regressed by an older queued response on a later read', async () => {
  mockRepository.runs.mockResolvedValue({ items: [reviewRunFixture('SUCCEEDED')], nextBeforeId: null })
  mockRepository.run.mockResolvedValueOnce(reviewRunFixture('SUCCEEDED')).mockResolvedValue(reviewRunFixture())
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.run?.status).toBe('SUCCEEDED'))
  await act(async () => view.result.current.refresh())
  await waitFor(() => expect(mockRepository.run).toHaveBeenCalledTimes(2))
  expect(view.result.current.run?.status).toBe('SUCCEEDED')
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a late older run cannot overwrite the run explicitly selected by the user', async () => {
  let finish!: (value: ReturnType<typeof reviewRunFixture>) => void
  mockRepository.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ...reviewRunFixture('SUCCEEDED'), id: 8 })
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(mockRepository.run).toHaveBeenCalled())
  await act(async () => view.result.current.selectRun(8))
  await waitFor(() => expect(view.result.current.run?.id).toBe(8))
  await act(async () => finish(reviewRunFixture()))
  expect(view.result.current.run?.id).toBe(8)
})

test('a read failure stops polling and remains an error rather than an empty successful result', async () => {
  jest.useFakeTimers()
  mockRepository.run.mockRejectedValue(new Error('offline'))
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.error).toBe('조회 오류'))
  const reads = mockRepository.run.mock.calls.length
  await act(async () => { await jest.advanceTimersByTimeAsync(9_000) })
  expect(mockRepository.run).toHaveBeenCalledTimes(reads)
  expect(view.result.current.run).toBeNull()
})
