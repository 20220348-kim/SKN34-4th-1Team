import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { ScrollView } from 'react-native'
import { ChatScreen } from './ChatScreen'
import { programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { programDetail } from '../test/preparationFixtures'
import { SupportProgramSearchRestoreApiError } from '@govbiz/shared/data/api/supportProgramApi'
import type { LoginRequest } from '../auth/loginFlow'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
beforeEach(() => { jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>) })
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn(), errorMessage: () => '요청 실패' }))

const context = { query: '사업화 지원', acceptingOnly: true,
  companyConditions: { region: '서울특별시', industry: null, establishedOn: null, foundedYear: null, supportPurpose: null } }

describe('mobile AI search', () => {
  it('waits for the user to confirm interpreted conditions before searching', async () => {
    const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: ['QUERY', 'REGION'] }),
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
      search: jest.fn().mockResolvedValue({ query: '사업화 지원', totalCount: 0, programs: [], resultToken: null, expiresAt: null }) }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '서울에서 사업화 지원을 찾고 있어요')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    await screen.findByText('이 조건으로 검색할까요?')
    expect(client.search).not.toHaveBeenCalled()
    fireEvent.press(screen.getByText('이 조건으로 검색'))
    await waitFor(() => expect(client.search).toHaveBeenCalledWith({ query: '사업화 지원', acceptingOnly: true, companyConditions: { region: '서울특별시' } }, expect.anything()))
    await screen.findByText('조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.')
  })

  it('blocks the paid search when the search index is unavailable', async () => {
    const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: ['QUERY'] }),
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: false, searchState: 'PREPARING' }), search: jest.fn() }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    await screen.findByText('이 조건으로 검색할까요?')
    fireEvent.press(screen.getByText('이 조건으로 검색'))
    await screen.findByText('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
    expect(client.search).not.toHaveBeenCalled()
  })
})

const resultToken = '00000000-0000-4000-8000-000000000001'
const programs = Array.from({ length: 5 }, (_, index) => ({ ...programDetail, id: `P${index}`, title: `추천 사업 ${index}`,
  matchedReasons: [], recommendationScore: null, eligibilityReview: null }))
const full = { query: context.query, programs, totalCount: 5, resultToken: null, expiresAt: null, context }
async function guestSearch(restoreSearch = jest.fn().mockResolvedValue(full)) {
  const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: [] }),
    getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
    search: jest.fn().mockResolvedValue({ ...full, programs: programs.slice(0, 2), resultToken, expiresAt: new Date(Date.now() + 60_000).toISOString() }), restoreSearch }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  const login = jest.fn<void, [LoginRequest?]>()
  const props = { onOpenProgram: jest.fn(), onLogin: login }
  const view = render(<ChatScreen {...props} />)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  await screen.findByText('이 조건으로 검색할까요?')
  fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
  await screen.findByLabelText('로그인하고 모두 보기')
  expect(screen.queryByText('추천 사업 2')).toBeNull()
  fireEvent.press(screen.getByLabelText('로그인하고 모두 보기'))
  return { client, login, view, props }
}
function signIn() {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'verified', account: { email: 'owner@example.com' } },
    invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>)
}

test('insufficient search details invite extra input and preserve the pending clarification for the next turn', async () => {
  const draftContext = { ...context, query: null }
  const client = { interpretConversation: jest.fn().mockResolvedValueOnce({ status: 'CLARIFICATION_REQUIRED', proposedContext: draftContext,
    answer: null, clarificationQuestion: '어떤 지원이 필요한가요?', changedFields: [] }).mockResolvedValueOnce({ status: 'READY', proposedContext: context,
    clarificationQuestion: null, changedFields: [] }), search: jest.fn() }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '지원사업 찾아줘')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  await screen.findByText('어떤 지원이 필요한가요?')
  const clarificationCard = within(screen.getByTestId('ai-search-clarification'))
  expect(clarificationCard.getByText('조금만 더 알려주세요')).toBeTruthy()
  expect(clarificationCard.getByText('답변을 입력해 주세요. 아직 검색하지 않았어요.')).toBeTruthy()
  expect(screen.getAllByLabelText('추가 내용 입력하기')).toHaveLength(1)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '작성 중인 추가 내용')
  expect(screen.queryByLabelText('새 대화')).toBeNull()
  fireEvent.press(screen.getByLabelText('추가 내용 입력하기'))
  expect(screen.getByLabelText('회사 상황이나 궁금한 점').props.value).toBe('작성 중인 추가 내용')
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
  expect(screen.getByText('지원사업 찾아줘')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '서울에서 사업화 지원이 필요해요')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  await screen.findByText('이 조건으로 검색할까요?')
  expect(client.interpretConversation).toHaveBeenLastCalledWith(expect.objectContaining({
    message: '서울에서 사업화 지원이 필요해요', pendingClarification: { question: '어떤 지원이 필요한가요?', draftContext },
  }), expect.any(AbortSignal))
  expect(client.search).not.toHaveBeenCalled()
})
test('selected guest results restore with the new token without repeating interpretation or paid search', async () => {
  const { client, view, props } = await guestSearch()
  signIn(); view.rerender(<ChatScreen {...props} />)
  await screen.findByText('추천 사업 4')
  expect(client.restoreSearch).toHaveBeenCalledWith(resultToken, expect.anything())
  expect(programClient).toHaveBeenCalledWith('verified')
  expect(client.search).toHaveBeenCalledTimes(1)
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('추가 지원사업 3건이 있어요')).toBeNull()
})
test('cancelled login retains public results and does not restore them during a later unrelated login', async () => {
  const { client, view, props, login } = await guestSearch()
  act(() => login.mock.calls[0][0]?.onCancel?.())
  expect(screen.getByText('추천 사업 0')).toBeTruthy()
  signIn(); view.rerender(<ChatScreen {...props} />)
  expect(client.restoreSearch).not.toHaveBeenCalled()
  expect(screen.queryByText('추천 사업 0')).toBeNull()
})
test('expired results require explicit condition confirmation before another paid search', async () => {
  const { client, view, props } = await guestSearch(jest.fn().mockRejectedValue(new SupportProgramSearchRestoreApiError('expired')))
  signIn(); view.rerender(<ChatScreen {...props} />)
  await screen.findByLabelText('같은 조건으로 다시 검색')
  expect(client.search).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('같은 조건으로 다시 검색'))
  expect(screen.getByText('이 조건으로 검색할까요?')).toBeTruthy()
  expect(client.search).toHaveBeenCalledTimes(1)
})
test('a late restored result cannot appear after logout or an account switch', async () => {
  let resolve!: (value: typeof full) => void
  const { view, props } = await guestSearch(jest.fn(() => new Promise<typeof full>(done => { resolve = done })))
  signIn(); view.rerender(<ChatScreen {...props} />)
  await screen.findByText('로그인 전 검색 결과를 불러오는 중이에요.')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  view.rerender(<ChatScreen {...props} />)
  await act(async () => resolve(full))
  expect(screen.queryByText('추천 사업 4')).toBeNull()
})

test('a restore authentication failure remains visible after the session is cleared', async () => {
  const { view, props } = await guestSearch(jest.fn().mockRejectedValue(new SupportProgramSearchRestoreApiError('unauthorized')))
  signIn(); view.rerender(<ChatScreen {...props} />)
  await screen.findByText('로그인이 만료되었습니다. 다시 로그인해 주세요.')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  view.rerender(<ChatScreen {...props} />)
  expect(screen.getByText('로그인이 만료되었습니다. 다시 로그인해 주세요.')).toBeTruthy()
  expect(screen.getByLabelText('다시 로그인')).toBeTruthy()
})

test.each(['signedOut', 'signedIn'] as const)('G01 uses the same introduction and fixed composer for %s without automatic AI calls', (status) => {
  const client = { interpretConversation: jest.fn(), search: jest.fn() }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  if (status === 'signedIn') signIn()
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  expect(screen.getByText('우리 회사에 맞는 지원사업,')).toBeTruthy()
  expect(screen.getByText('AI와 함께 무료로 찾아보세요.')).toBeTruthy()
  expect(screen.getByText('회사의 지역과 업종, 필요한 지원을 알려주세요.\n관련 공고와 확인할 신청 조건을 함께 안내합니다.')).toBeTruthy()
  expect(screen.getByLabelText('회사 상황이나 궁금한 점').props.placeholder).toBe('예: 서울에서 AI 서비스를 만드는 창업기업입니다. 사업화 지원을 받을 수 있을까요?')
  expect(screen.queryByText('우리 회사의 다음 기회,')).toBeNull()
  expect(screen.getByTestId('ai-search-composer')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '입력 중')
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(client.search).not.toHaveBeenCalled()
})

describe('mobile AI timeline scrolling', () => {
  let scrollTo: jest.SpyInstance
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  const ready = { status: 'READY', proposedContext: context, answer: '조건을 확인해 주세요.', clarificationQuestion: null, changedFields: [] }

  beforeEach(() => {
    frames = new Map(); nextFrame = 0
    scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo')
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { const id = ++nextFrame; frames.set(id, callback); return id })
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { if (id != null) frames.delete(id) })
  })
  afterEach(() => { cleanup(); jest.restoreAllMocks() })

  function flushFrame() {
    act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)) })
  }
  function layout(testID: string, y: number, height: number, width = 360) {
    fireEvent(screen.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y, width, height } } })
  }
  function timelineSize(content = 4_000, viewport = 600) {
    layout('ai-search-timeline', 0, viewport)
    fireEvent(screen.getByTestId('ai-search-timeline'), 'contentSizeChange', 360, content)
  }
  function clientWith(interpretConversation = jest.fn().mockResolvedValue(ready), search = jest.fn().mockResolvedValue(full)) {
    const client = { interpretConversation, search,
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }) }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    return client
  }
  async function send(text = '사업화 지원') {
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), text)
    await act(async () => { fireEvent.press(screen.getByLabelText('AI에게 보내기')) })
    expect(screen.queryByTestId('ai-search-pending-message')).toBeNull()
  }

  test('scrolls to the sent message, conditions, loading and the start of long results after layout', async () => {
    let resolveInterpret!: (value: typeof ready) => void
    let resolveSearch!: (value: typeof full) => void
    const client = clientWith(jest.fn(() => new Promise(resolve => { resolveInterpret = resolve })),
      jest.fn(() => new Promise(resolve => { resolveSearch = resolve })))
    const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
    const view = render(<ChatScreen {...props} />)
    timelineSize(); flushFrame()
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    expect(scrollTo).not.toHaveBeenCalled()
    expect(client.interpretConversation).not.toHaveBeenCalled()
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    flushFrame(); expect(scrollTo).not.toHaveBeenCalled()
    layout('ai-search-pending-message', 720, 80)
    layout('ai-search-waiting', 816, 48)
    expect(scrollTo).not.toHaveBeenCalled()
    flushFrame(); expect(scrollTo).toHaveBeenLastCalledWith({ y: 704, animated: true })

    await act(async () => resolveInterpret(ready))
    layout('ai-search-proposal', 1_100, 200)
    flushFrame(); expect(scrollTo).toHaveBeenLastCalledWith({ y: 1_084, animated: true })
    expect(client.search).not.toHaveBeenCalled()
    fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
    await waitFor(() => expect(client.search).toHaveBeenCalledTimes(1))
    layout('ai-search-waiting', 960, 48)
    flushFrame(); expect(scrollTo).toHaveBeenLastCalledWith({ y: 944, animated: true })

    await act(async () => resolveSearch(full))
    // The old content is too short: wait for its new size before moving.
    fireEvent(screen.getByTestId('ai-search-timeline'), 'contentSizeChange', 360, 1_500)
    layout('ai-search-results', 1_200, 2_500)
    flushFrame(); expect(scrollTo).toHaveBeenCalledTimes(3)
    timelineSize(5_000)
    flushFrame(); expect(scrollTo).toHaveBeenLastCalledWith({ y: 1_184, animated: true })
    expect(scrollTo).toHaveBeenCalledTimes(4)
    fireEvent.press(screen.getByLabelText('추천 사업 0, 상세 보기'))
    expect(props.onOpenProgram).toHaveBeenCalledWith({ sourceCode: programs[0].sourceCode, sourceProgramId: programs[0].id })

    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '다음 질문 작성 중')
    view.rerender(<ChatScreen {...props} />)
    layout('ai-search-results', 1_280, 2_500)
    timelineSize(5_100, 400); flushFrame()
    expect(scrollTo).toHaveBeenCalledTimes(4)
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    expect(client.search).toHaveBeenCalledTimes(1)
  })

  test('a new equal-sized proposal remains the target while previous results are still displayed', async () => {
    clientWith()
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    timelineSize()
    await send()
    const firstProposal = screen.getByTestId('ai-search-proposal')
    const staleProposalLayout = firstProposal.props.onLayout
    layout('ai-search-proposal', 800, 200); flushFrame()
    await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
    expect(screen.getByText('추천 사업 4')).toBeTruthy()
    layout('ai-search-results', 1_100, 1_500); flushFrame()
    scrollTo.mockClear()
    await send('서울 지원도 찾아줘')
    expect(screen.getByTestId('ai-search-proposal')).not.toBe(firstProposal)
    expect(screen.getByText('추천 사업 4')).toBeTruthy()
    act(() => staleProposalLayout({ nativeEvent: { layout: { x: 0, y: 800, width: 360, height: 200 } } }))
    layout('ai-search-results', 1_300, 1_500); flushFrame()
    expect(scrollTo).not.toHaveBeenCalled()
    layout('ai-search-proposal', 800, 200); flushFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ y: 784, animated: true })
    fireEvent.press(screen.getByLabelText('조건 바꾸기'))
    layout('ai-search-proposal', 820, 230); timelineSize(); flushFrame()
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  test.each(['CLARIFICATION_REQUIRED', 'ANSWERED'] as const)('shows repeated %s replies even when their size and the bounded history length stay unchanged', async (status) => {
    const client = clientWith(jest.fn().mockResolvedValue({ ...ready, status, answer: '새 답변', clarificationQuestion: '어느 지역인가요?' }))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    timelineSize()
    let previousAnswer: unknown
    for (let turn = 0; turn < 7; turn += 1) {
      await send('같은 질문')
      const answer = screen.getByTestId('ai-search-latest-answer')
      expect(answer).not.toBe(previousAnswer)
      previousAnswer = answer
      layout('ai-search-latest-answer', 800, 120); flushFrame()
    }
    expect(scrollTo).toHaveBeenCalledTimes(7)
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 784, animated: true })
    expect(client.search).not.toHaveBeenCalled()
  })

  test.each(['interpretation', 'search', 'readiness'] as const)('shows a new %s failure without jumping to old results', async (failure) => {
    const client = clientWith(failure === 'interpretation' ? jest.fn().mockRejectedValue(new Error('failed')) : undefined,
      failure === 'search' ? jest.fn().mockRejectedValue(new Error('failed')) : undefined)
    if (failure === 'readiness') client.getSearchReadiness.mockResolvedValue({ indexReady: false, searchState: 'PREPARING' })
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    timelineSize()
    await send()
    if (failure !== 'interpretation') {
      await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
      expect(screen.getByTestId('ai-search-notice')).toBeTruthy()
    }
    layout('ai-search-notice', 900, 120); flushFrame()
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 884, animated: true })
    if (failure === 'readiness') expect(client.search).not.toHaveBeenCalled()
  })

  test('zero results scroll to their result explanation and short content stays at the top', async () => {
    clientWith(undefined, jest.fn().mockResolvedValue({ ...full, totalCount: 0, programs: [] }))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    timelineSize(500)
    await send()
    await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
    expect(screen.getByText('조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.')).toBeTruthy()
    layout('ai-search-results', 280, 160); flushFrame()
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true })
  })

  test('login result restoration shows its loading and result start without another paid search', async () => {
    let resolveRestore!: (value: typeof full) => void
    const { client, view, props } = await guestSearch(jest.fn(() => new Promise(resolve => { resolveRestore = resolve })))
    timelineSize()
    signIn(); view.rerender(<ChatScreen {...props} />)
    await screen.findByText('로그인 전 검색 결과를 불러오는 중이에요.')
    layout('ai-search-waiting', 16, 50); flushFrame()
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: true })
    await act(async () => resolveRestore(full))
    layout('ai-search-results', 700, 2_000); flushFrame()
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 684, animated: true })
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
  })

  test.each(['cancel', 'account change', 'unmount'] as const)('%s discards queued layout and late response scrolling', async (action) => {
    let resolveOld!: (value: typeof ready) => void
    clientWith(jest.fn().mockResolvedValueOnce(ready).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve })))
    const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
    const view = render(<ChatScreen {...props} />)
    timelineSize()
    await send()
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '취소할 질문')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    const staleLayout = screen.getByTestId('ai-search-pending-message').props.onLayout
    layout('ai-search-pending-message', 800, 100)
    if (action === 'cancel') fireEvent.press(screen.getByLabelText('요청 취소'))
    else if (action === 'account change') { signIn(); view.rerender(<ChatScreen {...props} />) }
    else view.unmount()
    act(() => staleLayout({ nativeEvent: { layout: { x: 0, y: 800, width: 360, height: 100 } } }))
    await act(async () => resolveOld(ready))
    flushFrame()
    expect(scrollTo).not.toHaveBeenCalled()
    if (action !== 'unmount') { timelineSize(); flushFrame(); expect(scrollTo).not.toHaveBeenCalled() }
  })
})
