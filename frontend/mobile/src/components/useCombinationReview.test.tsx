import { act, renderHook, waitFor } from '@testing-library/react-native'
import { AppState } from 'react-native'
import { useCombinationReview } from './useCombinationReview'
import { mobileReview, reviewRunFixture } from '../test/reviewFixtures'
import type { CombinationReview, ReviewDraft } from '@govbiz/shared/domain/entities/CombinationReview'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import { readPendingReview, clearPendingReview, savePendingReview } from '../auth/reviewPending'

const mockRepository = { get: jest.fn(), runs: jest.fn(), run: jest.fn(), create: jest.fn(), replace: jest.fn(), start: jest.fn() }
const mockInvalidate = jest.fn().mockResolvedValue(undefined)
let stored: CombinationReview
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
  stored = structuredClone(mobileReview)
  mockInvalidate.mockClear()
  jest.mocked(readPendingReview).mockReset().mockResolvedValue(null)
  jest.mocked(clearPendingReview).mockReset().mockResolvedValue(undefined)
  jest.mocked(savePendingReview).mockReset().mockResolvedValue(undefined)
  mockRepository.get.mockImplementation(async () => stored)
  mockRepository.create.mockImplementation(async (draft: ReviewDraft) => { stored = { ...mobileReview, ...draft }; return stored })
  mockRepository.replace.mockImplementation(async (_id: number, revision: number, draft: ReviewDraft) => { stored = { ...stored, ...draft, inputRevision: revision + 1 } })
  mockRepository.start.mockResolvedValue(reviewRunFixture())
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

test('saving a new review creates one stable ID and never journals or starts analysis', async () => {
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', null))
  await waitFor(() => expect(view.result.current.storageReady).toBe(true))
  await act(async () => {
    view.result.current.setDraft({ title: '  단계 저장 검토  ', programs: mobileReview.programs })
    view.result.current.setFacts('실행 때만 저장할 설명')
  })
  let saved: CombinationReview | null = null
  await act(async () => { saved = await view.result.current.saveInputs() })
  expect(saved).toMatchObject({ id: 5, title: '단계 저장 검토', inputRevision: 1 })
  expect(view.result.current.dirty).toBe(false)
  expect(view.result.current.facts).toBe('실행 때만 저장할 설명')
  await act(async () => { await view.result.current.saveInputs() })
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  expect(mockRepository.replace).not.toHaveBeenCalled()
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(savePendingReview).not.toHaveBeenCalled()
  expect(clearPendingReview).not.toHaveBeenCalled()
})

test('changing participation saves the expected revision and analysis uses that saved revision without writing inputs again', async () => {
  mockRepository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft(previous => ({ ...previous,
    programs: previous.programs.map((program, index) => index ? program : { ...program, participation: { ...program.participation, fundingReceived: 'YES' } }) })))
  expect(view.result.current.dirty).toBe(true)
  await act(async () => { await view.result.current.saveInputs() })
  expect(mockRepository.replace).toHaveBeenCalledWith(5, 1, expect.objectContaining({ programs: expect.any(Array) }), expect.any(AbortSignal))
  expect(view.result.current.currentRevision).toBe(2)
  expect(view.result.current.dirty).toBe(false)
  expect(mockRepository.start).not.toHaveBeenCalled()
  await act(async () => view.result.current.setFacts('새 실행의 추가 설명'))
  await act(async () => { await view.result.current.start() })
  expect(mockRepository.start).toHaveBeenCalledWith(5, expect.objectContaining({ expectedRevision: 2, additionalFacts: '새 실행의 추가 설명' }), expect.any(AbortSignal))
  expect(mockRepository.create).not.toHaveBeenCalled()
  expect(mockRepository.replace).toHaveBeenCalledTimes(1)
})

test('analysis cannot silently save changed or unsaved inputs', async () => {
  mockRepository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft(previous => ({ ...previous, title: '아직 저장하지 않은 수정' })))
  await act(async () => { await view.result.current.start() })
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(mockRepository.create).not.toHaveBeenCalled()
  expect(mockRepository.replace).not.toHaveBeenCalled()
  expect(savePendingReview).not.toHaveBeenCalled()
  expect(view.result.current.dirty).toBe(true)
})

test('double save is serialized and failure preserves inputs for a manual retry', async () => {
  let fail!: (cause: Error) => void
  mockRepository.create.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', null))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft({ title: '유지할 제목', programs: mobileReview.programs }))
  let first!: Promise<CombinationReview | null>
  await act(async () => { first = view.result.current.saveInputs(); expect(await view.result.current.saveInputs()).toBeNull() })
  expect(view.result.current.saving).toBe(true)
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  await act(async () => { fail(new CombinationReviewError(503, 'REQUEST_FAILED')); await first })
  expect(view.result.current.draft.title).toBe('유지할 제목')
  expect(view.result.current.review).toBeNull()
  expect(view.result.current.saveError).toBe('조회 오류')
  expect(view.result.current.saving).toBe(false)
  await act(async () => { await view.result.current.saveInputs() })
  expect(view.result.current.review?.title).toBe('유지할 제목')
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a revision conflict or a mismatched confirmed response cannot mark edited inputs saved', async () => {
  mockRepository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  mockRepository.replace.mockRejectedValueOnce(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft(previous => ({ ...previous, title: '유지할 수정 제목' })))
  await act(async () => { expect(await view.result.current.saveInputs()).toBeNull() })
  expect(view.result.current.draft.title).toBe('유지할 수정 제목')
  expect(view.result.current.currentRevision).toBe(1)
  mockRepository.get.mockResolvedValueOnce({ ...mobileReview, title: '다른 입력', inputRevision: 2 })
  await act(async () => { expect(await view.result.current.saveInputs()).toBeNull() })
  expect(view.result.current.dirty).toBe(true)
  expect(view.result.current.currentRevision).toBe(1)
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a pending analysis request prevents input writes and keeps its original key intact', async () => {
  const pending = { reviewId: 5, request: { expectedRevision: 1, requestKey: '00000000-0000-4000-8000-000000000001', additionalFacts: '원래 설명' } }
  jest.mocked(readPendingReview).mockResolvedValue(pending)
  mockRepository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', 5))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft(previous => ({ ...previous, title: '변경 시도' })))
  await act(async () => { expect(await view.result.current.saveInputs()).toBeNull() })
  expect(view.result.current.pending).toEqual(pending)
  expect(mockRepository.replace).not.toHaveBeenCalled()
  expect(savePendingReview).not.toHaveBeenCalled()
  expect(clearPendingReview).not.toHaveBeenCalled()
})

test('an input save authentication failure invalidates the session without running analysis', async () => {
  mockRepository.create.mockRejectedValue(new CombinationReviewError(401, 'AUTH_REQUIRED'))
  const view = renderHook(() => useCombinationReview('token', 'owner@example.test', null))
  await waitFor(() => expect(view.result.current.loading).toBe(false))
  await act(async () => view.result.current.setDraft({ title: '저장할 입력', programs: mobileReview.programs }))
  await act(async () => { await view.result.current.saveInputs() })
  expect(mockInvalidate).toHaveBeenCalledTimes(1)
  expect(mockRepository.start).not.toHaveBeenCalled()
})
