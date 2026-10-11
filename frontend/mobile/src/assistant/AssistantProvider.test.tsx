import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { AppState, Keyboard, Platform, Text, View, type AppStateStatus } from 'react-native'
import { useAuth } from '../auth/session'
import { assistantUseCase } from '../api/assistant'
import { ApiError } from '../api/client'
import { PartnerSheet } from '../components/PartnerSheet'
import { Button } from '../ui'
import { AssistantProvider } from './AssistantProvider'
import { useAssistant } from './context'
import { defaultAssistantPosition, readAssistantPosition, saveAssistantPosition } from './assistantPosition'
import type { AskAssistantResult } from '@govbiz/shared/domain/repositories/AssistantRepository'

jest.setTimeout(15_000)
let mockPath = '/', mockParams: Record<string, string> = {}
const mockNavigate = jest.fn(), execute = jest.fn(), invalidate = jest.fn().mockResolvedValue(undefined)
jest.mock('expo-router', () => ({ usePathname: () => mockPath, useGlobalSearchParams: () => mockParams, useRouter: () => ({ navigate: mockNavigate }) }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/assistant', () => ({ ...jest.requireActual('../api/assistant'), assistantUseCase: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), getApiBaseUrl: () => 'https://api.example.test' }))
jest.mock('./assistantPosition', () => ({ ...jest.requireActual('./assistantPosition'), readAssistantPosition: jest.fn(), saveAssistantPosition: jest.fn() }))
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }))

const originalAI = process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED
function auth(status: 'signedIn' | 'signedOut' | 'loading' | 'unavailable' = 'signedIn', token = 'owner', email = 'owner@example.test') {
  jest.mocked(useAuth).mockReturnValue({ status, session: status === 'signedIn' ? { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', account: { email, company: null } } : null, invalidateSession: invalidate } as unknown as ReturnType<typeof useAuth>)
}
function answered(overrides: Record<string, unknown> = {}): AskAssistantResult {
  return { outcome: 'answered', answer: { intent: 'PRODUCT_HELP', answer: '서버에서 확인한 답변', citations: [], clarificationQuestion: null,
    searchQuery: null, accountTopic: null, navigation: null, cards: [], ...overrides } } as AskAssistantResult
}
function Probe() {
  const assistant = useAssistant()
  return <View><Button label="테스트 도우미 열기" onPress={assistant.open} /><Text testID="incoming-search">{assistant.searchDraft?.text ?? ''}</Text>
    <Text testID="incoming-program">{assistant.programDraft?.program.sourceProgramId ?? ''}</Text></View>
}
function App({ sheet = false }: { sheet?: boolean }) {
  return <AssistantProvider><Probe /><PartnerSheet visible={sheet} title="기존 시트" onClose={() => undefined} actions={null}><Text>기존 시트 내용</Text></PartnerSheet></AssistantProvider>
}
beforeEach(() => {
  auth(); mockPath = '/'; mockParams = {}; process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED = 'true'
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true })
  execute.mockReset().mockResolvedValue(answered()); invalidate.mockClear(); mockNavigate.mockReset()
  jest.mocked(assistantUseCase).mockReturnValue({ execute } as unknown as ReturnType<typeof assistantUseCase>)
  jest.mocked(readAssistantPosition).mockReset().mockResolvedValue(defaultAssistantPosition)
  jest.mocked(saveAssistantPosition).mockReset().mockResolvedValue(undefined)
})
afterEach(() => { jest.useRealTimers(); if (originalAI === undefined) delete process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED; else process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED = originalAI; jest.restoreAllMocks() })
async function open() { fireEvent.press(screen.getByLabelText('테스트 도우미 열기')); await act(async () => undefined) }
async function send(question = '지원사업 사용법') {
  fireEvent.changeText(screen.getByLabelText('도우미 질문'), question)
  fireEvent.press(screen.getByLabelText('도우미 질문 보내기'))
  await act(async () => undefined)
}

test.each(['signedOut', 'loading', 'unavailable'] as const)('%s cannot retain or invoke the mobile assistant', async status => {
  auth(status); render(<App />); await open()
  expect(screen.queryByLabelText('GovBiz 도우미 열기')).toBeNull()
  expect(screen.queryByLabelText('도우미 질문')).toBeNull()
  expect(execute).not.toHaveBeenCalled(); expect(readAssistantPosition).not.toHaveBeenCalled()
})
test('guided help and reopening preserve the signed-in conversation without any AI call', async () => {
  process.env.EXPO_PUBLIC_ASSISTANT_AI_ENABLED = 'false'
  render(<App />); await open()
  fireEvent.press(screen.getByLabelText('검색이 왜 바로 안 되나요?'))
  expect(screen.getByText(/AI가 정리한 조건을 확인한 뒤/)).toBeTruthy()
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  expect(screen.queryByLabelText('다른 주제 보기')).toBeNull()
  expect(screen.queryByLabelText('도우미 질문')).toBeNull()
  fireEvent.press(screen.getByLabelText('도우미 닫기')); await open()
  expect(screen.getByText(/AI가 정리한 조건을 확인한 뒤/)).toBeTruthy()
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  fireEvent.press(screen.getByLabelText('새 대화'))
  expect(screen.queryByText(/AI가 정리한 조건을 확인한 뒤/)).toBeNull()
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})

test.each([
  ['/', '지원사업 검색', '검색이 왜 바로 안 되나요?'],
  ['/saved', '관심 공고함', '저장한 공고는 어디서 보나요?'],
  ['/report', '기업 맞춤 리포트', '맞춤 리포트는 어떻게 확인하나요?'],
  ['/all/preparation/3/documents', '신청 문서 초안', '문서 생성 결과를 확인하지 못했어요.'],
  ['/all/preparation/3/review', '답변 검토', '작성한 답변은 어떻게 저장하고 검토하나요?'],
] as const)('opening from %s directly displays the corresponding page questions', async (path, label, question) => {
  mockPath = path; render(<App />); await open()
  expect(screen.getByText(`${label}에서 열었어요`)).toBeTruthy()
  expect(screen.getByLabelText(question)).toBeTruthy()
  expect(screen.queryByLabelText('협업')).toBeNull()
  expect(execute).not.toHaveBeenCalled()
})
test('other topics and free text remain accessible alongside page recommendations', async () => {
  render(<App />); await open()
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(screen.getByLabelText('도우미 질문')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('다른 주제 보기'))
  fireEvent.press(screen.getByLabelText('리포트'))
  fireEvent.press(screen.getByLabelText('맞춤 리포트는 어떻게 확인하나요?'))
  expect(screen.getByText(/등록한 기업 정보를 바탕으로/)).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})

test('collaboration title follows the current view without changing the route or invoking AI', async () => {
  mockPath = '/all/collab'; mockParams = { management: '0' }
  const view = render(<App />)
  await open()
  expect(screen.getByText('파트너 모집에서 열었어요')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('도우미 닫기'))
  mockParams = { management: '1' }; view.rerender(<App />)
  await open()
  expect(screen.getByText('파트너 관리에서 열었어요')).toBeTruthy()
  expect(mockNavigate).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

test('only starting the conversation hides recommendations, which stay hidden until a new conversation', async () => {
  let resolve!: (value: AskAssistantResult) => void
  execute.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<App />); await open()
  fireEvent.press(screen.getByLabelText('다른 주제 보기'))
  fireEvent.press(screen.getByLabelText('리포트'))
  expect(screen.getByLabelText('맞춤 리포트는 어떻게 확인하나요?')).toBeTruthy()

  fireEvent.changeText(screen.getByLabelText('도우미 질문'), '직접 작성 중인 질문')
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(screen.getByLabelText('맞춤 리포트는 어떻게 확인하나요?')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('도우미 질문 보내기'))
  await act(async () => undefined)
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  expect(screen.queryByLabelText('다른 주제 보기')).toBeNull()
  expect(screen.queryByLabelText('리포트')).toBeNull()
  expect(screen.queryByLabelText('맞춤 리포트는 어떻게 확인하나요?')).toBeNull()
  await act(async () => resolve(answered()))
  expect(screen.getByLabelText('도우미 질문').props.value).toBe('')
  expect(screen.getByText('서버에서 확인한 답변')).toBeTruthy()
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('도우미 질문'), '직접 작성 중인 질문')
  fireEvent.changeText(screen.getByLabelText('도우미 질문'), '')
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  fireEvent.press(screen.getByLabelText('새 대화'))
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(screen.queryByLabelText('리포트')).toBeNull()
  expect(screen.queryByText('서버에서 확인한 답변')).toBeNull()
  expect(screen.queryByText('직접 작성 중인 질문')).toBeNull()
  expect(execute).toHaveBeenCalledTimes(1)
  expect(mockNavigate).not.toHaveBeenCalled()
})

test.each(['ios', 'android'] as const)('%s reopening on the same page preserves recommendation visibility, conversation and draft', async os => {
  jest.replaceProperty(Platform, 'OS', os)
  render(<App />); await open()
  fireEvent.changeText(screen.getByLabelText('도우미 질문'), '아직 시작하지 않은 질문')
  fireEvent.press(screen.getByLabelText('도우미 닫기')); await open()
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(screen.getByDisplayValue('아직 시작하지 않은 질문')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
  await send('첫 번째 질문')
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('도우미 질문'), '아직 보내지 않은 질문')
  fireEvent.press(screen.getByLabelText('도우미 닫기')); await open()
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  expect(screen.queryByLabelText('다른 주제 보기')).toBeNull()
  expect(screen.getByDisplayValue('아직 보내지 않은 질문')).toBeTruthy()
  expect(screen.getByText('첫 번째 질문')).toBeTruthy()
  expect(screen.getByText('서버에서 확인한 답변')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('새 대화'))
  expect(screen.getByLabelText('검색이 왜 바로 안 되나요?')).toBeTruthy()
  expect(screen.getByLabelText('도우미 질문').props.value).toBe('')
  expect(screen.queryByText('서버에서 확인한 답변')).toBeNull()
  fireEvent.press(screen.getByLabelText('검색이 왜 바로 안 되나요?'))
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  expect(screen.getByText(/AI가 정리한 조건을 확인한 뒤/)).toBeTruthy()
  expect(execute).toHaveBeenCalledTimes(1)
})

test('reopening on a different page changes recommendations while retaining the conversation', async () => {
  const view = render(<App />); await open()
  fireEvent.press(screen.getByLabelText('검색이 왜 바로 안 되나요?'))
  expect(screen.queryByLabelText('검색이 왜 바로 안 되나요?')).toBeNull()
  fireEvent.press(screen.getByLabelText('도우미 닫기'))
  mockPath = '/report'; view.rerender(<App />); await open()
  expect(screen.getByText('기업 맞춤 리포트에서 열었어요')).toBeTruthy()
  expect(screen.getByLabelText('맞춤 리포트는 어떻게 확인하나요?')).toBeTruthy()
  expect(screen.getByText(/AI가 정리한 조건을 확인한 뒤/)).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})

test('opening a different program on the same route restores the current program recommendations', async () => {
  mockPath = '/program'; mockParams = { sourceCode: 'BIZINFO', sourceProgramId: 'P123' }
  const view = render(<App />); await open()
  fireEvent.press(screen.getByLabelText('이 공고의 원문에 질문하고 싶어요.'))
  expect(screen.queryByLabelText('이 공고의 원문에 질문하고 싶어요.')).toBeNull()
  fireEvent.press(screen.getByLabelText('도우미 닫기'))
  mockParams = { sourceCode: 'BIZINFO', sourceProgramId: 'P124' }; view.rerender(<App />); await open()
  expect(screen.getByLabelText('이 공고의 원문에 질문하고 싶어요.')).toBeTruthy()
  expect(screen.getByText(/선택한 공고의 원문을 근거로/)).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})
test('the program-page guided question opens the same program without asking AI or inventing a question', async () => {
  mockPath = '/program'; mockParams = { sourceCode: 'BIZINFO', sourceProgramId: 'P123' }
  render(<App />); await open()
  fireEvent.press(screen.getByLabelText('이 공고의 원문에 질문하고 싶어요.'))
  fireEvent.press(screen.getByLabelText('이 공고의 원문에 질문하기'))
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/program', params: mockParams })
  expect(screen.getByTestId('incoming-program').props.children).toBe('P123')
  expect(execute).not.toHaveBeenCalled()
})
test('free text uses canonical screen context and the bounded mobile help catalog', async () => {
  mockPath = '/program'; mockParams = { sourceCode: 'BIZINFO', sourceProgramId: 'P123' }
  render(<App />); await open(); await send('이 공고의 신청 조건')
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ context: { route: '/app/support-programs/detail', programSelected: true }, helpEntries: expect.any(Array), message: '이 공고의 신청 조건' }), expect.any(AbortSignal))
  expect(screen.getByText('서버에서 확인한 답변')).toBeTruthy()
})
test('logout aborts in-flight work and a late answer cannot reappear after a new login', async () => {
  let resolve!: (value: AskAssistantResult) => void
  execute.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  const view = render(<App />); await open(); await send('이전 계정 질문')
  const signal = execute.mock.calls[0][1] as AbortSignal
  auth('signedOut'); view.rerender(<App />)
  expect(signal.aborted).toBe(true)
  await act(async () => resolve(answered({ answer: '이전 계정 비공개 답변' })))
  auth('signedIn', 'new-token', 'other@example.test'); view.rerender(<App />); await open()
  expect(screen.queryByText('이전 계정 비공개 답변')).toBeNull()
  expect(screen.queryByText('이전 계정 질문')).toBeNull()
})
test('reauthentication of the same account starts a separate session conversation', async () => {
  const view = render(<App />); await open(); await send()
  auth('signedIn', 'reauthenticated-token'); view.rerender(<App />); await open()
  expect(screen.queryByText('서버에서 확인한 답변')).toBeNull()
})
test('closing pending work preserves the draft and ignores a late response', async () => {
  let resolve!: (value: AskAssistantResult) => void
  execute.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<App />); await open(); await send('닫아도 남는 질문')
  fireEvent.press(screen.getByLabelText('도우미 닫기'))
  expect((execute.mock.calls[0][1] as AbortSignal).aborted).toBe(true)
  await act(async () => resolve(answered({ answer: '늦은 답변' })))
  await open()
  expect(screen.getByLabelText('도우미 질문').props.value).toBe('닫아도 남는 질문')
  expect(screen.queryByText('늦은 답변')).toBeNull()
  expect(screen.getByText(/서버에서 이미 시작한 처리나 비용/)).toBeTruthy()
})
test('the deadline ends waiting even if transport does not cooperate with cancellation', async () => {
  jest.useFakeTimers()
  let resolve!: (value: AskAssistantResult) => void
  execute.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<App />); await open(); await send('시간 초과 질문')
  act(() => jest.advanceTimersByTime(45_001))
  expect((execute.mock.calls[0][1] as AbortSignal).aborted).toBe(true)
  expect(screen.getByText(/다시 전송하면 새 요청/)).toBeTruthy()
  expect(screen.getByLabelText('도우미 질문').props.value).toBe('시간 초과 질문')
  await act(async () => resolve(answered({ answer: '시간 초과 후 늦은 결과' })))
  expect(screen.queryByText('시간 초과 후 늦은 결과')).toBeNull()
  expect(execute).toHaveBeenCalledTimes(1)
})
test('background cancels pending work and foreground never replays the paid request', async () => {
  let changed!: (state: AppStateStatus) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { changed = listener; return { remove: () => undefined } })
  execute.mockImplementationOnce(() => new Promise(() => undefined))
  render(<App />); await open(); await send()
  act(() => changed('background'))
  expect((execute.mock.calls[0][1] as AbortSignal).aborted).toBe(true)
  act(() => changed('active'))
  expect(screen.getByText(/백그라운드로 전환되어 답변 대기를 중지/)).toBeTruthy()
  expect(execute).toHaveBeenCalledTimes(1)
})
test('rate limits enforce server wait time and do not automatically resend', async () => {
  jest.useFakeTimers()
  execute.mockResolvedValueOnce({ outcome: 'rate-limited', retryAfterSeconds: 2 }).mockResolvedValue(answered())
  render(<App />); await open(); await send()
  expect(screen.getByLabelText('도우미 질문 보내기').props.accessibilityState.disabled).toBe(true)
  act(() => jest.advanceTimersByTime(2100))
  expect(execute).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('도우미 질문 보내기')); await act(async () => undefined)
  expect(execute).toHaveBeenCalledTimes(2)
})
test('AI unavailability retains input and is displayed as an error', async () => {
  execute.mockResolvedValue({ outcome: 'unavailable' })
  render(<App />); await open(); await send('다시 확인할 질문')
  expect(screen.getByText(/AI 도우미를 이용할 수 없어요/)).toBeTruthy()
  expect(screen.getByLabelText('도우미 질문').props.value).toBe('다시 확인할 질문')
})
test('401 invalidates the verified native session', async () => {
  execute.mockRejectedValue(new ApiError(401, 'expired'))
  render(<App />); await open(); await send()
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
})
test('search handoff stays in the session and navigation alone does not run a search', async () => {
  execute.mockResolvedValue(answered({ intent: 'SEARCH', searchQuery: '서울 AI 사업화', navigation: { label: '검색어 입력하기', to: '/app/chat' } }))
  const view = render(<App />); await open(); await send()
  fireEvent.press(screen.getByLabelText('검색어 입력하기'))
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/(tabs)', params: { mode: 'ai' } })
  expect(screen.getByTestId('incoming-search').props.children).toBe('서울 AI 사업화')
  expect(execute).toHaveBeenCalledTimes(1)
  auth('signedOut'); view.rerender(<App />)
  expect(screen.getByTestId('incoming-search').props.children).toBe('')
})
test('selected-program questions preserve the ID and remain drafts', async () => {
  mockPath = '/program'; mockParams = { sourceCode: 'BIZINFO', sourceProgramId: 'P/한글:123' }
  execute.mockResolvedValue(answered({ intent: 'PROGRAM_QUESTION' }))
  render(<App />); await open(); await send('우리 회사도 신청할 수 있나요?')
  fireEvent.press(screen.getByLabelText('이 공고의 원문에 질문하기'))
  expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/program', params: mockParams })
  expect(screen.getByTestId('incoming-program').props.children).toBe('P/한글:123')
})
test('unsupported navigation displays a failure and cannot open arbitrary routes', async () => {
  execute.mockResolvedValue(answered({ navigation: { label: '잘못된 이동', to: '/app/not-supported' } }))
  render(<App />); await open(); await send()
  expect(screen.getByText(/이 답변의 이동 경로를 확인하지 못했어요/)).toBeTruthy()
  expect(screen.queryByLabelText('잘못된 이동')).toBeNull(); expect(mockNavigate).not.toHaveBeenCalled()
})
test('existing sheets block the launcher and the shared entry point', async () => {
  const view = render(<App sheet />); await act(async () => undefined)
  expect(screen.queryByLabelText('GovBiz 도우미 열기')).toBeNull()
  await open(); expect(screen.queryByLabelText('도우미 질문')).toBeNull()
  view.rerender(<App />); await act(async () => undefined)
  expect(screen.getByLabelText('GovBiz 도우미 열기')).toBeTruthy()
})
test('keyboard events hide only the launcher and restore it afterward', async () => {
  const listeners: Record<string, () => void> = {}
  jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => { listeners[name] = listener as () => void; return { remove: () => undefined } as ReturnType<typeof Keyboard.addListener> })
  render(<App />); await act(async () => undefined)
  act(() => listeners.keyboardDidShow())
  expect(screen.queryByLabelText('GovBiz 도우미 열기')).toBeNull()
  act(() => listeners.keyboardDidHide())
  expect(screen.getByLabelText('GovBiz 도우미 열기')).toBeTruthy()
})
test('a late preference restore cannot overwrite a position the user already chose', async () => {
  let resolve!: (value: typeof defaultAssistantPosition) => void
  jest.mocked(readAssistantPosition).mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<App />)
  fireEvent(screen.getByLabelText('GovBiz 도우미 열기'), 'accessibilityAction', { nativeEvent: { actionName: 'moveLeft' } })
  await act(async () => resolve({ edge: 'right', height: .2 }))
  fireEvent(screen.getByLabelText('GovBiz 도우미 열기'), 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
  expect(saveAssistantPosition).toHaveBeenLastCalledWith('https://api.example.test', 'owner@example.test', { edge: 'left', height: expect.closeTo(.86) })
})
