import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'
import { router } from 'expo-router'
import { CombinationReviewError } from '@govbiz/shared/domain/errors/CombinationReviewError'
import type { CombinationReview, ReviewDraft, RunRequest } from '@govbiz/shared/domain/entities/CombinationReview'
import { MobileCombinationReviewRepository } from '../api/combinationReviews'
import { apiRequest, programClient } from '../api/client'
import { CombinationReviewEditorScreen, CombinationReviewListScreen } from './CombinationReviewScreens'
import { answerRunFixture, mobileReview, reviewPrograms, reviewRequestKey, reviewRunFixture } from '../test/reviewFixtures'
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
const editor = (id: number | null = null) => <CombinationReviewEditorScreen id={id} onLogin={jest.fn()} onOpenProgram={onOpen} />
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

/** 공고 선택 다음은 바로 분석 확인 단계예요. 내 상황(상태 · 관계 · 추가 설명)은 그 단계의 선택 칸이에요. */
async function prepare() {
  await screen.findByText('검색 결과 3건')
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '두 사업의 참여 검토')
  fireEvent.press(screen.getByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
}
async function confirm() {
  await prepare()
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '같은 비용을 사용하려고 합니다.')
}
/** 내 상황의 사업별 지금 상태를 골라요. 관계 칸의 "모름" 칩과 섞이지 않게 선택 시트 항목(이름이 정확히 같은 것)만 눌러요. */
function chooseStatus(index: number, current: string, next: string) {
  fireEvent.press(screen.getByLabelText(`사업 ${index} 지금 상태: ${current}`))
  fireEvent.press(screen.getAllByRole('radio', { name: next }).find(option => option.props.accessibilityLabel === next)!)
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

test('choosing programs goes straight to the analysis step and the optional situation is saved by the run before explicit admission', async () => {
  render(editor())
  await prepare()
  // 참여 상태 단계 없이 분석 확인 단계에 내 상황(선택) 칸이 있어요. 단계 표시는 두 단계예요.
  expect(screen.getByText('1. 공고 선택')).toBeTruthy()
  expect(screen.getByText('2. 분석 확인')).toBeTruthy()
  expect(screen.queryByText(/참여 상태/)).toBeNull()
  expect(screen.getByText('내 상황')).toBeTruthy()
  expect(screen.getByLabelText('사업 1 지금 상태: 모름')).toBeTruthy()
  for (const question of ['같은 과제·제품인가요?', '같은 비용 항목에 쓰나요?']) {
    expect(screen.getByRole('radio', { name: `${question} 모름` }).props.accessibilityState.checked).toBe(true)
  }
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  expect(mockRepository.create.mock.calls[0][0].relation).toEqual({ sameProject: 'UNKNOWN', sameCost: 'UNKNOWN' })
  chooseStatus(1, '모름', '선정 · 협약 · 수행 중')
  fireEvent.press(screen.getByRole('radio', { name: '같은 비용 항목에 쓰나요? 예' }))
  expect(screen.getByRole('radio', { name: '같은 비용 항목에 쓰나요? 예' }).props.accessibilityState.checked).toBe(true)
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '같은 비용')
  expect(screen.getByText('바꾼 내 상황은 [검토 실행]을 누르면 저장한 뒤 분석해요.')).toBeTruthy()
  // 고르기만 해서는 저장 · 분석하지 않아요. 바꾼 내 상황은 실행을 막지 않고 [검토 실행]이 먼저 저장해요.
  expect(mockRepository.replace).not.toHaveBeenCalled()
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(screen.getByText('검토 실행')).toBeEnabled()
  fireEvent.press(screen.getByText('검토 실행'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  expect(mockRepository.replace).toHaveBeenCalledTimes(1)
  const input = mockRepository.replace.mock.calls[0][2]
  expect(mockRepository.replace.mock.calls[0][1]).toBe(1)
  expect(input.programs[0].participation).toMatchObject({ executionStatus: 'IN_PROGRESS', fundingReceived: 'UNKNOWN', selected: 'UNKNOWN' })
  expect(input.relation).toEqual({ sameProject: 'UNKNOWN', sameCost: 'YES' })
  expect(input).not.toHaveProperty('additionalFacts')
  expect(mockRepository.start).toHaveBeenCalledTimes(1)
  expect(mockRepository.start.mock.calls[0][1]).toEqual({ expectedRevision: 2, requestKey: reviewRequestKey, additionalFacts: '같은 비용' })
  expect(mockRepository.replace.mock.invocationCallOrder[0]).toBeLessThan(mockRepository.start.mock.invocationCallOrder[0])
  expect(entries.size).toBe(0)
})

test('lost admission responses retain the exact key and facts for an explicit same-request confirmation', async () => {
  mockRepository.start.mockRejectedValueOnce(new Error('network interrupted'))
  render(editor())
  await confirm()
  fireEvent.press(screen.getByText('검토 실행'))
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
  fireEvent.press(screen.getByText('검토 실행'))
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
  await screen.findByText('이 내용으로 검토할까요?')
  expect(screen.getByText('검토 실행')).toBeDisabled()
  expect(screen.getByTestId('review-start-reason')).toHaveTextContent('완료 여부를 확인하지 못한 실행이 있어 새 분석을 막았어요')
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('revision conflicts preserve edited inputs and never start analysis', async () => {
  mockRepository.get.mockResolvedValue(saved)
  mockRepository.replace.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
  render(editor(5))
  await screen.findByText('아직 분석 결과가 없어요. 입력을 확인한 뒤 명시적으로 분석을 요청해 주세요.')
  fireEvent.press(screen.getByText('입력 수정하기'))
  await screen.findByText('이 내용으로 검토할까요?')
  chooseStatus(1, '모름', '신청 전')
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '유지할 설명')
  fireEvent.press(screen.getByText('검토 실행'))
  await screen.findByText(/저장된 입력이나 분석 요청이 변경됐어요/)
  expect(screen.getByDisplayValue('유지할 설명')).toBeTruthy()
  expect(screen.getByLabelText('사업 1 지금 상태: 신청 전')).toBeTruthy()
  expect(screen.getByText('이 내용으로 검토할까요?')).toBeTruthy()
  expect(mockRepository.replace).toHaveBeenCalledWith(5, 1, expect.anything(), expect.anything())
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(entries.size).toBe(0)
})

test('a failed first step save keeps title and program choices and a retry creates the review once', async () => {
  mockRepository.create.mockRejectedValueOnce(new CombinationReviewError(503, 'REQUEST_FAILED'))
  render(editor())
  await screen.findByText('검색 결과 3건')
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '저장 실패에도 유지할 제목')
  fireEvent.press(screen.getByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  await screen.findByText('저장하지 못했어요. 입력은 이 화면에 유지됩니다.')
  expect(screen.getByDisplayValue('저장 실패에도 유지할 제목')).toBeTruthy()
  expect(screen.getByText('2 / 2 선택')).toBeTruthy()
  expect(screen.queryByText('이 내용으로 검토할까요?')).toBeNull()
  expect(mockRepository.start).not.toHaveBeenCalled()
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(mockRepository.create).toHaveBeenCalledTimes(2)
  expect(screen.getByText('제목·공고·내 상황 저장됨')).toBeTruthy()
})

test('going back to program selection saves the changed situation and keeps extra facts without analysis', async () => {
  render(editor())
  await prepare()
  chooseStatus(1, '모름', '신청 전')
  fireEvent.press(screen.getByRole('radio', { name: '같은 과제·제품인가요? 아니오' }))
  fireEvent.changeText(screen.getByLabelText('추가로 알려줄 내용 (선택)'), '실행할 때만 저장할 설명')
  fireEvent.press(screen.getByText('공고 선택으로'))
  await screen.findByLabelText('검토 제목')
  expect(mockRepository.replace).toHaveBeenCalledTimes(1)
  expect(mockRepository.replace.mock.calls[0][2].relation).toEqual({ sameProject: 'NO', sameCost: 'UNKNOWN' })
  expect(mockRepository.replace.mock.calls[0][2].programs[0].participation).toMatchObject({ applicationSubmitted: 'NO' })
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(mockRepository.create).toHaveBeenCalledTimes(1)
  expect(mockRepository.replace).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('사업 1 지금 상태: 신청 전')).toBeTruthy()
  expect(screen.getByRole('radio', { name: '같은 과제·제품인가요? 아니오' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByDisplayValue('실행할 때만 저장할 설명')).toBeTruthy()
  expect(screen.getByText(/추가 설명은 검토 실행을 요청할 때/)).toBeTruthy()
  expect(mockRepository.start).not.toHaveBeenCalled()
  expect(entries.size).toBe(0)
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

test('a late first-step save from a previous account cannot move the new account to the saved route', async () => {
  let finish!: (value: CombinationReview) => void
  mockRepository.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const onStepChange = jest.fn()
  const props = { id: null, onStepChange, onLogin: jest.fn(), onOpenProgram: onOpen }
  const view = render(<CombinationReviewEditorScreen {...props} />)
  await screen.findByText('검색 결과 3건')
  fireEvent.changeText(screen.getByLabelText('검토 제목'), '첫 계정의 새 검토')
  fireEvent.press(screen.getByLabelText('검토 사업 1 선택'))
  fireEvent.press(screen.getByLabelText('검토 사업 2 선택'))
  fireEvent.press(screen.getByText('다음 · 분석 확인'))
  const signal = mockRepository.create.mock.calls[0][1] as AbortSignal
  mockAuth = { ...mockAuth, session: { accessToken: 'second-token', account: { email: 'second@example.test' } } }
  view.rerender(<CombinationReviewEditorScreen {...props} />)
  await screen.findByLabelText('검토 제목')
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ ...mobileReview, title: '첫 계정의 새 검토' }))
  expect(onStepChange).not.toHaveBeenCalled()
  expect(screen.queryByDisplayValue('첫 계정의 새 검토')).toBeNull()
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
  const props = { id: 5, onLogin: jest.fn(), onOpenProgram: onOpen }
  const view = render(<CombinationReviewEditorScreen {...props} runId={6} />)
  await screen.findByText('실행 6의 입력')
  view.rerender(<CombinationReviewEditorScreen {...props} runId={8} />)
  await screen.findByText('실행 8의 입력')
  expect(screen.queryByText('실행 6의 입력')).toBeNull()
  expect(mockRepository.start).not.toHaveBeenCalled()
})

test('a relation saved on the web is shown and sent back unchanged when the app saves other inputs', async () => {
  saved = { ...structuredClone(mobileReview), relation: { sameProject: 'YES', sameCost: 'NO' } }
  render(editor(5))
  await screen.findByText('아직 분석 결과가 없어요. 입력을 확인한 뒤 명시적으로 분석을 요청해 주세요.')
  fireEvent.press(screen.getByText('입력 수정하기'))
  await screen.findByText('이 내용으로 검토할까요?')
  expect(screen.getByRole('radio', { name: '같은 과제·제품인가요? 예' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByRole('radio', { name: '같은 비용 항목에 쓰나요? 아니오' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByText('제목·공고·내 상황 저장됨')).toBeTruthy()
  // 상태만 바꾸고 실행해도 웹에서 고른 관계를 그대로 보내요.
  chooseStatus(2, '모름', '받음 · 종료')
  fireEvent.press(screen.getByText('검토 실행'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(mockRepository.replace).toHaveBeenCalledTimes(1)
  expect(mockRepository.replace.mock.calls[0][2].relation).toEqual({ sameProject: 'YES', sameCost: 'NO' })
  expect(mockRepository.replace.mock.calls[0][2].programs[1].participation).toMatchObject({ executionStatus: 'COMPLETED' })
  expect(mockRepository.start.mock.calls[0][1]).toMatchObject({ expectedRevision: 2 })
})

test('choosing 모름 for a program status clears only the progress facts and keeps the separately saved funding answer', async () => {
  saved = { ...structuredClone(mobileReview), programs: mobileReview.programs.map((program, index) => index ? program : { ...program,
    participation: { applicationSubmitted: 'YES', selected: 'YES', commitmentSubmitted: 'YES', agreementSigned: 'YES', executionStatus: 'IN_PROGRESS', fundingReceived: 'YES' } }) }
  render(editor(5))
  await screen.findByText('아직 분석 결과가 없어요. 입력을 확인한 뒤 명시적으로 분석을 요청해 주세요.')
  fireEvent.press(screen.getByText('입력 수정하기'))
  await screen.findByText('이 내용으로 검토할까요?')
  chooseStatus(1, '선정 · 협약 · 수행 중', '모름')
  expect(screen.getByLabelText('사업 1 지금 상태: 모름')).toBeTruthy()
  fireEvent.press(screen.getByText('검토 실행'))
  await screen.findByText('검토 요청이 접수됐어요')
  expect(mockRepository.replace.mock.calls[0][2].programs[0].participation).toEqual({
    applicationSubmitted: 'UNKNOWN', selected: 'UNKNOWN', commitmentSubmitted: 'UNKNOWN', agreementSigned: 'UNKNOWN', executionStatus: 'UNKNOWN', fundingReceived: 'YES' })
})

describe('three-question result actions', () => {
  const queued = (id: number) => ({ ...reviewRunFixture(), id })
  function acceptAs(id: number) {
    mockRepository.start.mockImplementation(async (_id: number, input: RunRequest) => {
      request = input
      return { ...queued(id), requestKey: input.requestKey, inputRevision: input.expectedRevision,
        input: { ...reviewRunFixture().input, title: saved.title, programs: saved.programs, additionalFacts: input.additionalFacts } }
    })
  }

  test('narrowing a three-question result saves the situation, starts one run on the saved revision and shows that run', async () => {
    const answered = answerRunFixture()
    mockRepository.runs.mockResolvedValue({ items: [answered], nextBeforeId: null })
    mockRepository.run.mockImplementation(async (_id: number, runId: number) => runId === answered.id ? answered
      : { ...queued(runId), inputRevision: 2, input: { ...reviewRunFixture().input, additionalFacts: request?.additionalFacts ?? '' } })
    acceptAs(40)
    render(editor(5))
    await screen.findByText('1. 둘 다 신청할 수 있나요?')
    expect(screen.getAllByRole('header').map(node => node.props.children).slice(-4))
      .toEqual(['1. 둘 다 신청할 수 있나요?', '2. 둘 다 되면 함께 수행할 수 있나요?', '3. 같은 과제·비용으로 두 번 받는 것은 아닌가요?', '내 상황으로 좁히기'])
    // 바꾼 것이 없으면 다시 분석하지 않아요.
    const submit = screen.getByRole('button', { name: '저장하고 다시 분석' })
    expect(submit).toBeDisabled()
    expect(screen.getByTestId('review-narrowing-reason')).toHaveTextContent('상황을 바꾸면 다시 분석할 수 있어요')
    chooseStatus(1, '모름', '신청 전')
    fireEvent.press(screen.getByRole('radio', { name: '같은 비용 항목에 쓰나요? 아니오' }))
    expect(screen.queryByTestId('review-narrowing-reason')).toBeNull()
    expect(screen.getByRole('button', { name: '저장하고 다시 분석' })).toBeEnabled()
    expect(mockRepository.replace).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('button', { name: '저장하고 다시 분석' }))
    await screen.findByText('검토 요청이 접수됐어요')
    expect(mockRepository.replace).toHaveBeenCalledTimes(1)
    expect(mockRepository.replace).toHaveBeenCalledWith(5, 1, expect.objectContaining({ relation: { sameProject: 'UNKNOWN', sameCost: 'NO' } }), expect.any(AbortSignal))
    expect(mockRepository.replace.mock.calls[0][2].programs[0].participation).toMatchObject({ applicationSubmitted: 'NO', selected: 'UNKNOWN', executionStatus: 'UNKNOWN' })
    expect(mockRepository.start).toHaveBeenCalledTimes(1)
    // 좁혀 다시 분석해도 지난 실행의 추가 설명을 이어서 보내요.
    expect(mockRepository.start.mock.calls[0][1]).toEqual({ expectedRevision: 2, requestKey: reviewRequestKey, additionalFacts: answered.input.additionalFacts })
    expect(mockRepository.replace.mock.invocationCallOrder[0]).toBeLessThan(mockRepository.start.mock.invocationCallOrder[0])
    await waitFor(() => expect(mockRepository.run).toHaveBeenCalledWith(5, 40, expect.anything()))
    expect(screen.queryByText('1. 둘 다 신청할 수 있나요?')).toBeNull()
    expect(entries.size).toBe(0)
  })

  test('a revision conflict while narrowing keeps the chosen situation and starts nothing', async () => {
    const answered = answerRunFixture()
    mockRepository.runs.mockResolvedValue({ items: [answered], nextBeforeId: null })
    mockRepository.run.mockResolvedValue(answered)
    mockRepository.replace.mockRejectedValue(new CombinationReviewError(409, 'COMBINATION_REVIEW_REVISION_CONFLICT'))
    render(editor(5))
    await screen.findByText('내 상황으로 좁히기')
    fireEvent.press(screen.getByRole('radio', { name: '같은 과제·제품인가요? 예' }))
    fireEvent.press(screen.getByRole('button', { name: '저장하고 다시 분석' }))
    await screen.findByText(/저장된 입력이나 분석 요청이 변경됐어요/)
    expect(screen.getByRole('radio', { name: '같은 과제·제품인가요? 예' }).props.accessibilityState.checked).toBe(true)
    expect(screen.getByText('1. 둘 다 신청할 수 있나요?')).toBeTruthy()
    expect(mockRepository.start).not.toHaveBeenCalled()
    expect(entries.size).toBe(0)
  })

  test('an old six-stage result starts a new analysis from its notice with the saved input and the same extra facts', async () => {
    const legacy = { ...reviewRunFixture('SUCCEEDED'), input: { ...reviewRunFixture('SUCCEEDED').input, additionalFacts: '지난 실행의 설명' } }
    mockRepository.runs.mockResolvedValue({ items: [legacy], nextBeforeId: null })
    mockRepository.run.mockImplementation(async (_id: number, runId: number) => runId === legacy.id ? legacy : queued(runId))
    acceptAs(41)
    render(editor(5))
    const notice = within(await screen.findByTestId('review-legacy-notice'))
    expect(screen.queryByText('내 상황으로 좁히기')).toBeNull()
    expect(screen.getByRole('button', { name: '내 상황 입력하고 다시 보기' })).toBeTruthy()
    fireEvent.press(notice.getByRole('button', { name: '새 방식으로 다시 분석' }))
    await screen.findByText('검토 요청이 접수됐어요')
    expect(mockRepository.replace).not.toHaveBeenCalled()
    expect(mockRepository.start).toHaveBeenCalledTimes(1)
    expect(mockRepository.start.mock.calls[0][1]).toEqual({ expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '지난 실행의 설명' })
  })

  test.each([
    ['another run is in progress', 'RUNNING', '분석이 끝나면 다시 실행할 수 있어요'],
    ['a run outcome is unconfirmed', 'UNKNOWN', '완료 여부를 확인하지 못한 실행이 있어 새 분석을 막았어요'],
  ] as const)('the new-analysis action on an old result is disabled with a reason while %s', async (_case, status, reason) => {
    const legacy = reviewRunFixture('SUCCEEDED')
    mockRepository.runs.mockResolvedValue({ items: [{ ...reviewRunFixture(status), id: 7 }, legacy], nextBeforeId: null })
    mockRepository.run.mockResolvedValue(legacy)
    render(<CombinationReviewEditorScreen id={5} runId={6} onLogin={jest.fn()} onOpenProgram={onOpen} />)
    const notice = within(await screen.findByTestId('review-legacy-notice'))
    expect(notice.getByRole('button', { name: '새 방식으로 다시 분석' })).toBeDisabled()
    expect(notice.getByTestId('review-reanalyze-reason')).toHaveTextContent(reason)
    fireEvent.press(notice.getByRole('button', { name: '새 방식으로 다시 분석' }))
    expect(mockRepository.start).not.toHaveBeenCalled()
  })

  test('an unconfirmed admission blocks narrowing until the same request is confirmed', async () => {
    const answered = answerRunFixture()
    jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(JSON.stringify({ reviewId: 5, request: { expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: '' } }))
    mockRepository.runs.mockResolvedValue({ items: [answered], nextBeforeId: null })
    mockRepository.run.mockResolvedValue(answered)
    render(editor(5))
    await screen.findByText('내 상황으로 좁히기')
    expect(screen.getByText('같은 요청으로 확인')).toBeTruthy()
    fireEvent.press(screen.getByRole('radio', { name: '같은 과제·제품인가요? 예' }))
    expect(screen.getByRole('button', { name: '저장하고 다시 분석' })).toBeDisabled()
    expect(screen.getByTestId('review-narrowing-reason')).toHaveTextContent('응답을 확인하지 못한 분석 요청이 있어요. 화면 위의 [같은 요청으로 확인]을 먼저 눌러 주세요.')
    expect(mockRepository.replace).not.toHaveBeenCalled()
    expect(mockRepository.start).not.toHaveBeenCalled()
  })
})
