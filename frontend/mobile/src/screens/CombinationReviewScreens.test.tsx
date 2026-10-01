import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'
import { router } from 'expo-router'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import type { CombinationReview, ReviewDraft, RunRequest } from '@govbiz/shared/domain/entities/CombinationReview'
import { MobileCombinationReviewRepository } from '../api/combinationReviews'
import { apiRequest, programClient } from '../api/client'
import { CombinationReviewEditorScreen, CombinationReviewListScreen } from './CombinationReviewScreens'
import { mobileReview, reviewPrograms, reviewRequestKey, reviewRunFixture } from '../test/reviewFixtures'
import { colors } from '../ui'

const mockRepository = { get: jest.fn(), create: jest.fn(), replace: jest.fn(), delete: jest.fn(), list: jest.fn(), runs: jest.fn(), run: jest.fn(), start: jest.fn(), source: jest.fn() }
const mockInvalidate = jest.fn()
let mockAuth: { status: string; session: null | { accessToken: string; account: { email: string } }; invalidateSession: typeof mockInvalidate }
jest.mock('../auth/session', () => ({ useAuth: () => mockAuth }))
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const router = { push: jest.fn(), replace: jest.fn(), navigate: jest.fn() }
  return { router, useRouter: () => router, useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }
})
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }))
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn(), apiRequest: jest.fn() }))
jest.mock('../api/combinationReviews', () => ({ ...jest.requireActual('../api/combinationReviews'), MobileCombinationReviewRepository: jest.fn().mockImplementation(() => mockRepository) }))

const entries = new Map<string, string>()
const onOpen = jest.fn()
let saved: CombinationReview
let request: RunRequest | null
const editor = (id: number | null = null) => <CombinationReviewEditorScreen id={id} onLogin={jest.fn()} onList={jest.fn()} onOpenProgram={onOpen} />
beforeEach(() => {
  entries.clear(); request = null; saved = structuredClone(mobileReview)
  mockAuth = { status: 'signedIn', session: { accessToken: 'first-token', account: { email: 'first@example.test' } }, invalidateSession: mockInvalidate }
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  for (const method of Object.values(mockRepository)) method.mockReset()
  jest.mocked(MobileCombinationReviewRepository).mockImplementation(() => mockRepository as unknown as MobileCombinationReviewRepository)
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async key => entries.get(key) ?? null)
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { entries.set(key, value) })
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async key => { entries.delete(key) })
  mockRepository.get.mockImplementation(async () => saved)
  mockRepository.create.mockImplementation(async (draft: ReviewDraft) => { saved = { ...mobileReview, ...draft }; return saved })
  mockRepository.replace.mockImplementation(async (_id: number, revision: number, draft: ReviewDraft) => { saved = { ...saved, ...draft, inputRevision: revision + 1 } })
  mockRepository.runs.mockResolvedValue({ items: [], nextBeforeId: null })
  mockRepository.run.mockImplementation(async () => ({ ...reviewRunFixture(), input: { ...reviewRunFixture().input, title: saved.title, programs: saved.programs, additionalFacts: request?.additionalFacts ?? '' } }))
  mockRepository.start.mockImplementation(async (_id: number, input: RunRequest) => {
    request = input
    return { ...reviewRunFixture(), requestKey: input.requestKey, inputRevision: input.expectedRevision,
      input: { ...reviewRunFixture().input, title: saved.title, programs: saved.programs, additionalFacts: input.additionalFacts } }
  })
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({ programs: reviewPrograms, total: 3, page: 1, pageSize: 12, totalPages: 1,
    regions: ['전국'], categories: ['기술'], startupStages: [], applicantTypes: [], founderAges: [] }),
    getDetail: jest.fn().mockImplementation(async (identity: { sourceProgramId: string }) => ({ ...reviewPrograms.find(item => item.id === identity.sourceProgramId), evidenceQuestionSupported: true,
      applicationRoute: { method: null, url: null, type: 'UNKNOWN' } })),
  } as unknown as ReturnType<typeof programClient>)
  jest.mocked(apiRequest).mockResolvedValue({ programs: reviewPrograms.map(program => ({ savedAt: '2026-10-01',
    program: { ...program, sourceUrl: `https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=${program.id}` },
  })) })
})
afterEach(() => { delete process.env.EXPO_PUBLIC_API_BASE_URL })

async function prepare() {
  await screen.findByText('검색 결과 3건')
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '두 사업의 참여 검토')
  fireEvent.press(screen.getByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
  fireEvent.press(screen.getByText('다음 · 참여 상태 입력'))
  await screen.findByText('현재 참여 상태를 알려주세요')
}
async function confirm() {
  await prepare()
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '같은 비용을 사용하려고 합니다.')
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
}

test('private views gate anonymous users without reading private data or running AI', () => {
  mockAuth = { ...mockAuth, status: 'signedOut', session: null }
  const view = render(editor())
  expect(screen.getByText('로그인하고 시작')).toBeTruthy()
  expect(MobileCombinationReviewRepository).not.toHaveBeenCalled()
  expect(programClient).not.toHaveBeenCalled()
  view.unmount()
  render(<CombinationReviewListScreen onNew={jest.fn()} onLogin={jest.fn()} />)
  expect(apiRequest).not.toHaveBeenCalled()
})

test('existing search cards retain summary/detail behavior and selections across search tabs', async () => {
  render(editor())
  await screen.findByText('검색 결과 3건')
  expect(screen.getAllByText('공식 API 요약 테스트')).toHaveLength(3)
  fireEvent.press(screen.getByLabelText('검토 사업 1, 상세 보기'))
  expect(onOpen).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_100' })
  expect(screen.getByText('0 / 2 선택')).toBeTruthy()
  expect(screen.getByTestId('review-program-BIZINFO-PBLN_100')).toHaveStyle({ backgroundColor: colors.surface })
  fireEvent.press(screen.getByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
  expect(screen.getByLabelText('검토 사업 3 선택')).toBeDisabled()
  expect(screen.getByLabelText('검토 사업 3, 상세 보기')).toBeEnabled()
  expect(screen.getByTestId('review-program-BIZINFO-PBLN_100')).toHaveStyle({ backgroundColor: colors.soft, borderColor: colors.primary })
  expect(screen.getAllByText('✓ 비교 대상 선택됨')).toHaveLength(2)
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '유지할 검색어')
  fireEvent.press(screen.getByRole('tab', { name: '관심 공고함' }))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/saved-programs', expect.objectContaining({ accessToken: 'first-token' })))
  await waitFor(() => expect(screen.getByTestId('review-program-BIZINFO-PBLN_100')).toHaveStyle({ backgroundColor: colors.soft, borderColor: colors.primary }))
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  expect(screen.getByDisplayValue('유지할 검색어')).toBeTruthy()
  expect(screen.getByText('2 / 2 선택')).toBeTruthy()
  expect(mockRepository.create).not.toHaveBeenCalled()
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(programClient().browseCatalog).toHaveBeenCalledWith(expect.objectContaining({ status: 'ALL' }), expect.anything())
  await act(async () => fireEvent.press(screen.getByLabelText('검토 사업 1 선택 해제')))
  expect(screen.getByTestId('review-program-BIZINFO-PBLN_100')).toHaveStyle({ backgroundColor: colors.surface, borderColor: 'transparent' })
  expect(screen.getAllByText('✓ 비교 대상 선택됨')).toHaveLength(1)
})

test('explicit confirmation saves independent participation/funding then admits a queued run once', async () => {
  render(editor())
  await prepare()
  fireEvent.press(screen.getByLabelText('사업 1 현재 참여 상태: 잘 모르겠음'))
  fireEvent.press(screen.getByRole('radio', { name: '수행 중' }))
  fireEvent.press(screen.getByLabelText('사업 1 실제 지원금 지급 여부: 잘 모르겠음'))
  fireEvent.press(screen.getByRole('radio', { name: '아니오' }))
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '같은 비용')
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  expect(mockRepository.start).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('저장하고 분석 요청'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  const input = mockRepository.create.mock.calls[0][0]
  expect(input.programs[0].participation).toMatchObject({ executionStatus: 'IN_PROGRESS', fundingReceived: 'NO', selected: 'UNKNOWN' })
  expect(mockRepository.start).toHaveBeenCalledTimes(1)
  expect(mockRepository.start.mock.calls[0][1]).toEqual({ expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '같은 비용' })
  expect(entries.size).toBe(0)
})

test('lost admission responses retain the exact key and facts for an explicit same-request confirmation', async () => {
  mockRepository.start.mockRejectedValueOnce(new Error('network interrupted'))
  render(editor())
  await confirm()
  fireEvent.press(screen.getByText('저장하고 분석 요청'))
  await screen.findByText('같은 요청으로 확인')
  const first = mockRepository.start.mock.calls[0][1]
  expect([...entries.values()].some(value => value.includes(first.requestKey))).toBe(true)
  fireEvent.press(screen.getByText('같은 요청으로 확인'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(mockRepository.start.mock.calls[1][1]).toEqual(first)
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
})

test('failure to journal a request prevents an AI POST', async () => {
  render(editor())
  await confirm()
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('device unavailable'))
  fireEvent.press(screen.getByText('저장하고 분석 요청'))
  await screen.findByText('분석 요청을 안전하게 보관하지 못해 분석을 시작하지 않았어요. 보관 상태를 다시 확인해 주세요.')
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('an UNKNOWN execution blocks new analysis without treating it as success or automatically retrying', async () => {
  const unknown = reviewRunFixture('UNKNOWN')
  mockRepository.runs.mockResolvedValue({ items: [unknown], nextBeforeId: null })
  mockRepository.run.mockResolvedValue(unknown)
  render(editor(5))
  await screen.findByText(/분석 완료 여부를 확인하지 못했어요/)
  fireEvent.press(screen.getByText('입력 수정하기'))
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  expect(screen.getByText('저장하고 분석 요청')).toBeDisabled()
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('revision conflicts preserve edited inputs and never start analysis', async () => {
  mockRepository.get.mockResolvedValue(saved)
  mockRepository.replace.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
  render(editor(5))
  await screen.findByText('아직 분석 결과가 없어요. 입력을 확인한 뒤 명시적으로 분석을 요청해 주세요.')
  fireEvent.press(screen.getByText('입력 수정하기'))
  fireEvent.press(screen.getByLabelText('사업 1 현재 참여 상태: 잘 모르겠음'))
  fireEvent.press(screen.getByRole('radio', { name: '신청 전' }))
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '유지할 설명')
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  fireEvent.press(screen.getByText('저장하고 분석 요청'))
  await screen.findByText(/저장된 입력이나 분석 요청이 변경됐어요/)
  expect(screen.getByText('유지할 설명')).toBeTruthy()
  expect(mockRepository.replace).toHaveBeenCalledWith(5, 1, expect.anything(), expect.anything())
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a late previous account response cannot render another account draft', async () => {
  let finish!: (value: CombinationReview) => void
  mockRepository.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const second = { ...mockRepository, get: jest.fn().mockResolvedValue({ ...mobileReview, title: '두 번째 계정의 검토' }) }
  jest.mocked(MobileCombinationReviewRepository).mockImplementation(token => (token === 'second-token' ? second : mockRepository) as unknown as MobileCombinationReviewRepository)
  const view = render(editor(5))
  await waitFor(() => expect(mockRepository.get).toHaveBeenCalled())
  mockAuth = { ...mockAuth, session: { accessToken: 'second-token', account: { email: 'second@example.test' } } }
  view.rerender(editor(5))
  await screen.findByText('두 번째 계정의 검토')
  await act(async () => finish({ ...mobileReview, title: '첫 번째 계정 비공개 입력' }))
  expect(screen.queryByText('첫 번째 계정 비공개 입력')).toBeNull()
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a pending request for another review is linked instead of overwritten', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(JSON.stringify({ reviewId: 17, request: { expectedRevision: 2, requestKey: reviewRequestKey, additionalFacts: '기존 사실' } }))
  render(editor())
  fireEvent.press(await screen.findByText('미확인 요청의 검토 열기'))
  expect(router.replace).toHaveBeenCalledWith({ pathname: '/all/reviews/[id]', params: { id: '17' } })
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('changing a deep-link run on the same review opens the requested snapshot rather than keeping the old one', async () => {
  mockRepository.runs.mockResolvedValue({ items: [reviewRunFixture('SUCCEEDED')], nextBeforeId: null })
  mockRepository.run.mockImplementation(async (_id: number, runId: number) => ({ ...reviewRunFixture('SUCCEEDED'), id: runId,
    input: { ...reviewRunFixture().input, title: `실행 ${runId}의 입력` } }))
  const props = { id: 5, onLogin: jest.fn(), onList: jest.fn(), onOpenProgram: onOpen }
  const view = render(<CombinationReviewEditorScreen {...props} runId={6} />)
  await screen.findByText('실행 6의 입력')
  view.rerender(<CombinationReviewEditorScreen {...props} runId={8} />)
  await screen.findByText('실행 8의 입력')
  expect(screen.queryByText('실행 6의 입력')).toBeNull()
  expect(mockRepository.start).not.toHaveBeenCalled()
})
