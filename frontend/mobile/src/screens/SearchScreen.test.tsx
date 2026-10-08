import { useState } from 'react'
import { ScrollView } from 'react-native'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { SearchScreen, type SearchMode } from './SearchScreen'
import { Stack, Tabs, router } from 'expo-router'
import { renderRouter } from 'expo-router/testing-library'
import SearchRoute from '../../app/(tabs)/index'
import ProgramRoute from '../../app/program'
import { LoginFlowProvider } from '../auth/loginFlow'
import { programDetail } from '../test/preparationFixtures'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
const emptyPage = { programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
  startupStages: [], applicantTypes: [], founderAges: [] }
const context = { query: '사업화 지원', acceptingOnly: true,
  companyConditions: { region: null, industry: null, establishedOn: null, foundedYear: null, supportPurpose: null } }

function Host() {
  const [mode, setMode] = useState<SearchMode>('ai')
  return <SearchScreen mode={mode} onModeChange={setMode} onOpenProgram={jest.fn()} onLogin={jest.fn()} />
}

beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
})

test('switching search modes retains inputs and results without querying an unvisited mode or refetching', async () => {
  const client = { browseCatalog: jest.fn().mockResolvedValue(emptyPage), interpretConversation: jest.fn().mockResolvedValue({
    status: 'READY', proposedContext: context, answer: '조건을 확인해 주세요.', clarificationQuestion: null, changedFields: ['QUERY'],
  }), search: jest.fn() }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  render(<Host />)
  expect(client.browseCatalog).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  await screen.findByText('이 조건으로 검색할까요?')
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '이어서 작성 중')
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  await screen.findByText('검색 결과 0건')
  expect(screen.queryByText('이 조건으로 검색할까요?')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '적용할 필터')
  fireEvent(screen.getByLabelText('공고명·기관명'), 'submitEditing')
  await waitFor(() => expect(client.browseCatalog).toHaveBeenCalledTimes(2))
  await screen.findByText('검색 결과 0건')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '입력 중인 필터')
  fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
  expect(screen.getByDisplayValue('이어서 작성 중')).toBeTruthy()
  expect(screen.getByText('이 조건으로 검색할까요?')).toBeTruthy()
  expect(screen.queryByLabelText('공고명·기관명')).toBeNull()
  expect(screen.queryByTestId('catalog-condition-summary')).toBeNull()
  expect(screen.getByRole('tab', { name: 'AI 대화 검색' })).toBeSelected()
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  expect(screen.getByDisplayValue('입력 중인 필터')).toBeTruthy()
  expect(within(screen.getByTestId('catalog-condition-summary')).getByText('검색어: 적용할 필터 ×')).toBeTruthy()
  expect(screen.getByText('검색어는 키보드의 검색을 눌러 적용해 주세요.')).toBeTruthy()
  expect(client.browseCatalog).toHaveBeenCalledTimes(2)
  expect(client.search).not.toHaveBeenCalled()
}, 15_000)

test('an account change clears a hidden AI panel and ignores the old request response', async () => {
  let resolveOld!: (value: unknown) => void
  const client = { browseCatalog: jest.fn().mockResolvedValue(emptyPage),
    interpretConversation: jest.fn(() => new Promise((resolve) => { resolveOld = resolve })) }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  const view = render(<Host />)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '이전 계정의 질문')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  await screen.findByText('검색 결과 0건')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'new-account-token' } } as ReturnType<typeof useAuth>)
  view.rerender(<Host />)
  await act(async () => resolveOld({ status: 'READY', proposedContext: context, answer: '이전 계정 답변' }))
  fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
  expect(screen.queryByText('이전 계정 답변')).toBeNull()
  expect(screen.queryByText('이 조건으로 검색할까요?')).toBeNull()
  expect(screen.getByLabelText('회사 상황이나 궁금한 점').props.value).toBe('')
})

test('a reply received in the hidden AI panel scrolls once on return and later mode switches retain the position', async () => {
  let resolveReply!: (value: unknown) => void
  const client = { browseCatalog: jest.fn().mockResolvedValue(emptyPage), search: jest.fn(),
    interpretConversation: jest.fn(() => new Promise(resolve => { resolveReply = resolve })) }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo')
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { const id = ++nextFrame; frames.set(id, callback); return id })
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { if (id != null) frames.delete(id) })
  const flushFrame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)) })
  const layoutEvent = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 360, height } } })
  try {
    const view = render(<Host />)
    const timeline = screen.getByTestId('ai-search-timeline')
    fireEvent(timeline, 'layout', layoutEvent(0, 600))
    fireEvent(timeline, 'contentSizeChange', 360, 3_000)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    fireEvent(screen.getByTestId('ai-search-pending-message'), 'layout', layoutEvent(600, 100))
    fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
    await screen.findByText('검색 결과 0건')
    flushFrame(); expect(scrollTo).not.toHaveBeenCalled()
    await act(async () => resolveReply({ status: 'READY', proposedContext: context, answer: '조건을 확인해 주세요.', clarificationQuestion: null, changedFields: [] }))
    // Hidden native panels can still deliver layout events; they must not scroll.
    const hiddenProposal = screen.getByTestId('ai-search-proposal', { includeHiddenElements: true })
    fireEvent(hiddenProposal, 'layout', layoutEvent(1_000, 200))
    flushFrame(); expect(scrollTo).not.toHaveBeenCalled()
    fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
    fireEvent(screen.getByTestId('ai-search-proposal'), 'layout', layoutEvent(1_200, 200))
    flushFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ y: 1_184, animated: true })
    fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
    fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
    fireEvent(screen.getByTestId('ai-search-proposal'), 'layout', layoutEvent(1_200, 200))
    fireEvent(timeline, 'contentSizeChange', 360, 3_200)
    flushFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    expect(client.search).not.toHaveBeenCalled()
    view.unmount()
  } finally { jest.restoreAllMocks() }
}, 15_000)

test('AI result opens the real program detail and returns to the same draft and scroll view without another request', async () => {
  const program = { ...programDetail, title: 'AI 추천 공고', matchedReasons: [], recommendationScore: null, eligibilityReview: null }
  const client = {
    interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, answer: '조건을 확인해 주세요.', clarificationQuestion: null, changedFields: [] }),
    getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
    search: jest.fn().mockResolvedValue({ query: context.query, totalCount: 1, programs: [program], resultToken: null, expiresAt: null }),
    getDetail: jest.fn().mockResolvedValue(programDetail),
    // 상세 화면의 공식 첨부 카드도 같은 클라이언트로 목록을 읽습니다. 첨부가 없으면 카드를 그리지 않습니다.
    getAttachments: jest.fn().mockResolvedValue([]),
  }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo')
  try {
    const view = renderRouter({
      _layout: () => <LoginFlowProvider><Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack></LoginFlowProvider>,
      '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none' }}><Tabs.Screen name="index" /></Tabs>,
      '(tabs)/index': SearchRoute,
      program: ProgramRoute,
    }, { initialUrl: '/?mode=ai' })
    const timeline = await screen.findByTestId('ai-search-timeline')
    const layoutEvent = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 360, height } } })
    fireEvent(timeline, 'layout', layoutEvent(0, 600))
    fireEvent(timeline, 'contentSizeChange', 360, 3_000)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    await act(async () => { fireEvent.press(screen.getByLabelText('AI에게 보내기')) })
    await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
    await screen.findByText('AI 추천 공고')
    fireEvent(screen.getByTestId('ai-search-results'), 'layout', layoutEvent(800, 1_200))
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ y: 784, animated: true }))
    const moves = scrollTo.mock.calls.length
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '상세 확인 후 이어 쓸 질문')
    fireEvent.press(screen.getByLabelText('AI 추천 공고, 상세 보기'))
    await screen.findByLabelText('공식 공고 원문 열기')
    expect(view.getPathname()).toBe('/program')
    expect(client.getDetail).toHaveBeenCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id }, expect.anything())
    expect(client.getAttachments).toHaveBeenCalledWith({ sourceCode: program.sourceCode, sourceProgramId: program.id }, expect.any(AbortSignal))
    expect(screen.getByText('중소기업')).toBeTruthy()
    expect(screen.queryByLabelText('더 보기')).toBeNull()
    await act(async () => router.back())
    await screen.findByDisplayValue('상세 확인 후 이어 쓸 질문')
    expect(view.getPathname()).toBe('/')
    expect(view.getSearchParams()).toMatchObject({ mode: 'ai' })
    expect(screen.getByTestId('ai-search-timeline')).toBe(timeline)
    fireEvent(screen.getByTestId('ai-search-results'), 'layout', layoutEvent(800, 1_200))
    fireEvent(timeline, 'contentSizeChange', 360, 3_100)
    await act(async () => { await jest.advanceTimersByTimeAsync(20) })
    expect(scrollTo).toHaveBeenCalledTimes(moves)
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(client.getDetail).toHaveBeenCalledTimes(1)
    expect(client.getAttachments).toHaveBeenCalledTimes(1)
    view.unmount()
  } finally { jest.useRealTimers(); jest.restoreAllMocks() }
}, 15_000)
