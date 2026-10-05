import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert, Text, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import type { CombinationReview, ReviewDraft, RunRequest } from '@govbiz/shared/domain/entities/CombinationReview'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import NewReviewRoute from '../../app/(tabs)/all/reviews/new'
import ReviewRoute from '../../app/(tabs)/all/reviews/[id]'
import { useAuth } from '../auth/session'
import { programClient } from '../api/client'
import { MobileCombinationReviewRepository, listReviewSavedPrograms } from '../api/combinationReviews'
import { mobileReview, reviewPrograms, reviewRequestKey, reviewRunFixture } from '../test/reviewFixtures'
import { readPendingReview, savePendingReview, clearPendingReview } from '../auth/reviewPending'
import { Button } from '../ui'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../api/combinationReviews', () => ({ ...jest.requireActual('../api/combinationReviews'), MobileCombinationReviewRepository: jest.fn(), listReviewSavedPrograms: jest.fn() }))
jest.mock('../auth/reviewPending', () => ({ readPendingReview: jest.fn(), savePendingReview: jest.fn(), clearPendingReview: jest.fn() }))
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }))
const repository = { get: jest.fn(), create: jest.fn(), replace: jest.fn(), runs: jest.fn(), run: jest.fn(), start: jest.fn() }
let stored: CombinationReview
let accepted: RunRequest | null
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  index: () => <View><Button label="새 검토 열기" onPress={() => router.push('/all/reviews/new')} />
    <Button label="저장된 검토 열기" onPress={() => router.push({ pathname: '/all/reviews/[id]', params: { id: '5', step: 'participation' } })} /></View>,
  'all/reviews/new': NewReviewRoute,
  'all/reviews/[id]': ReviewRoute,
  'all/reviews/index': () => <Text>검토 목록</Text>,
}
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  stored = structuredClone(mobileReview); accepted = null
  Object.values(repository).forEach(method => method.mockReset())
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@test.com' } },
    invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(MobileCombinationReviewRepository).mockImplementation(() => repository as unknown as MobileCombinationReviewRepository)
  jest.mocked(readPendingReview).mockReset().mockResolvedValue(null)
  jest.mocked(savePendingReview).mockReset().mockResolvedValue(undefined)
  jest.mocked(clearPendingReview).mockReset().mockResolvedValue(undefined)
  repository.get.mockImplementation(async () => stored)
  repository.create.mockImplementation(async (draft: ReviewDraft) => { stored = { ...mobileReview, ...draft }; return stored })
  repository.replace.mockImplementation(async (_id: number, revision: number, draft: ReviewDraft) => { stored = { ...stored, ...draft, inputRevision: revision + 1 } })
  repository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  repository.start.mockImplementation(async (_id: number, request: RunRequest) => {
    accepted = request
    return { ...reviewRunFixture(), inputRevision: request.expectedRevision,
      input: { ...reviewRunFixture().input, title: stored.title, programs: stored.programs, additionalFacts: request.additionalFacts } }
  })
  repository.run.mockImplementation(async () => ({ ...reviewRunFixture(), inputRevision: accepted?.expectedRevision ?? stored.inputRevision,
    input: { ...reviewRunFixture().input, title: stored.title, programs: stored.programs, additionalFacts: accepted?.additionalFacts ?? '' } }))
  jest.mocked(listReviewSavedPrograms).mockResolvedValue(reviewPrograms)
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({ programs: reviewPrograms, total: 3, page: 1, pageSize: 12, totalPages: 1,
    regions: ['전국'], categories: ['기술'], startupStages: [], applicantTypes: [], founderAges: [] }),
    getDetail: jest.fn().mockImplementation(async (identity: { sourceProgramId: string }) => reviewPrograms.find(program => program.id === identity.sourceProgramId)),
  } as unknown as ReturnType<typeof programClient>)
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL; jest.restoreAllMocks() })

async function fillSelection() {
  await screen.findByLabelText('검토 제목')
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '단계마다 저장할 검토')
  fireEvent.press(await screen.findByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
}

test('actual routes save each step, keep facts across step parameters and start only from explicit review execution', async () => {
  const view = renderRouter(routes, { initialUrl: '/all/reviews/new' })
  await fillSelection()
  fireEvent.press(screen.getByLabelText('다음 · 참여 상태 입력'))
  await screen.findByText('현재 참여 상태를 알려주세요')
  expect(view.getPathname()).toBe('/all/reviews/5')
  expect(view.getSearchParams()).toMatchObject({ step: 'participation' })
  expect(repository.create).toHaveBeenCalledTimes(1)
  expect(repository.start).not.toHaveBeenCalled(); expect(savePendingReview).not.toHaveBeenCalled()
  fireEvent.press(await screen.findByLabelText('사업 1 현재 참여 상태: 잘 모르겠음'))
  fireEvent.press(screen.getByRole('radio', { name: '신청 전' }))
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '이번 실행에만 보내는 설명')
  fireEvent.press(screen.getByLabelText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(view.getSearchParams()).toMatchObject({ step: 'confirm' })
  expect(repository.replace).toHaveBeenCalledWith(5, 1, expect.anything(), expect.any(AbortSignal))
  expect(stored.inputRevision).toBe(2)
  expect(repository.start).not.toHaveBeenCalled()
  expect(screen.getByText('이번 실행에만 보내는 설명')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('입력 수정'))
  await screen.findByDisplayValue('이번 실행에만 보내는 설명')
  fireEvent.press(screen.getByLabelText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(repository.create).toHaveBeenCalledTimes(1); expect(repository.replace).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('검토 실행'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(view.getSearchParams()).toMatchObject({ step: 'analysis' })
  expect(repository.start).toHaveBeenCalledWith(5, { expectedRevision: 2, requestKey: reviewRequestKey, additionalFacts: '이번 실행에만 보내는 설명' }, expect.any(AbortSignal))
  expect(repository.create).toHaveBeenCalledTimes(1); expect(repository.replace).toHaveBeenCalledTimes(1)
})

test('a first-step save failure keeps the new route and inputs until manual retry succeeds', async () => {
  repository.create.mockRejectedValueOnce(new CombinationReviewError(503, 'REQUEST_FAILED'))
  const view = renderRouter(routes, { initialUrl: '/all/reviews/new' })
  await fillSelection()
  fireEvent.press(screen.getByLabelText('다음 · 참여 상태 입력'))
  await screen.findByText('저장하지 못했어요. 입력은 이 화면에 유지됩니다.')
  expect(view.getPathname()).toBe('/all/reviews/new')
  expect(screen.getByDisplayValue('단계마다 저장할 검토')).toBeTruthy()
  expect(screen.getByText('2 / 2 선택')).toBeTruthy()
  expect(repository.start).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('다음 · 참여 상태 입력'))
  await screen.findByText('현재 참여 상태를 알려주세요')
  expect(view.getPathname()).toBe('/all/reviews/5')
  expect(repository.create).toHaveBeenCalledTimes(2)
})

test('saved inputs can be reopened after normal back navigation without adding an exit confirmation or analysis', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText('새 검토 열기'))
  await fillSelection()
  fireEvent.press(screen.getByLabelText('다음 · 참여 상태 입력'))
  await screen.findByText('현재 참여 상태를 알려주세요')
  await act(async () => router.back())
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(alert).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('저장된 검토 열기'))
  await screen.findByText('현재 참여 상태를 알려주세요')
  fireEvent.press(screen.getByLabelText('공고 선택으로'))
  await screen.findByDisplayValue('단계마다 저장할 검토')
  expect(view.getSearchParams()).toMatchObject({ step: 'selection' })
  expect(repository.create).toHaveBeenCalledTimes(1)
  expect(repository.replace).not.toHaveBeenCalled()
  expect(repository.start).not.toHaveBeenCalled()
})

test('a deep link to confirmation cannot execute unsaved changes', async () => {
  const view = renderRouter(routes, { initialUrl: '/all/reviews/5?step=selection' })
  await screen.findByDisplayValue(mobileReview.title)
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '저장하지 않은 제목')
  await act(async () => router.setParams({ step: 'confirm' }))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(view.getSearchParams()).toMatchObject({ step: 'confirm' })
  expect(screen.getByLabelText('검토 실행').props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByLabelText('검토 실행'))
  expect(repository.start).not.toHaveBeenCalled()
})
