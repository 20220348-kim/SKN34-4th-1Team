import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { Alert, ScrollView, StyleSheet } from 'react-native'
import { ChatScreen } from './ChatScreen'
import { programClient } from '../api/client'
import { planUsageUseCase } from '../api/planUsage'
import { useAuth } from '../auth/session'
import { colors } from '../ui'
import { programDetail } from '../test/preparationFixtures'
import { SupportProgramRequestApiError, SupportProgramSearchRestoreApiError, SupportProgramSearchTimeoutApiError } from '@govbiz/shared/data/api/supportProgramApi'
import type { PlanUsage } from '@govbiz/shared/domain/entities/PlanUsage'
import type { LoginRequest } from '../auth/loginFlow'
import { deleteChatConversation, getChatConversation, listChatConversations, saveChatConversation } from '../api/chatConversations'
let mockMessageNumber = 0
jest.mock('expo-crypto', () => ({ randomUUID: () => `message-${++mockMessageNumber}` }))

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/planUsage', () => ({ planUsageUseCase: jest.fn() }))
beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  // 이용량 줄을 확인하는 테스트만 응답을 정합니다. 나머지 흐름에서는 응답이 오지 않아 아무것도 보이지 않습니다.
  usageResponses()
})
jest.mock('../api/chatConversations', () => ({ deleteChatConversation: jest.fn(), getChatConversation: jest.fn(), listChatConversations: jest.fn(), saveChatConversation: jest.fn() }))
beforeEach(() => {
  mockMessageNumber = 0
  jest.mocked(saveChatConversation).mockReset().mockImplementation(async (_token, _email, id, version) => ({ id, title: '사업화 지원', version: version + 1, updatedAt: '2026-10-08T09:00:00' }))
  jest.mocked(listChatConversations).mockReset().mockResolvedValue({ items: [], nextCursor: null })
  jest.mocked(getChatConversation).mockReset()
  jest.mocked(deleteChatConversation).mockReset().mockResolvedValue(undefined)
})

describe('conversation deletion', () => {
  afterEach(() => jest.restoreAllMocks())
  async function recordedConversation() {
    signIn()
    const client = historyClient()
    const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
    const view = render(<ChatScreen {...props} />)
    await sendQuestion('삭제할 대화')
    const saved = jest.mocked(saveChatConversation).mock.calls[0]
    const record = { id: saved[2], title: '삭제할 대화', version: 1, updatedAt: '2026-10-08T09:00:00' }
    jest.mocked(listChatConversations).mockResolvedValue({ items: [record, { ...record, id: 'other', title: '다른 기록' }], nextCursor: null })
    fireEvent.press(screen.getByLabelText('대화 기록'))
    await screen.findByLabelText('대화 삭제: 삭제할 대화')
    return { view, props, record, client }
  }
  function deletionConfirmation(alert: jest.SpyInstance) {
    return alert.mock.calls.at(-1)![2].find((button: { style: string }) => button.style === 'destructive').onPress as () => void
  }

  test('confirmation is required and a successful current-record deletion clears the screen only after the response', async () => {
    const alert = jest.spyOn(Alert, 'alert')
    const { record, client } = await recordedConversation()
    fireEvent.press(screen.getByLabelText('대화 삭제: 삭제할 대화'))
    expect(deleteChatConversation).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledWith('대화 기록을 삭제할까요?', expect.stringContaining('삭제할 대화'), expect.any(Array))
    let finish!: () => void
    jest.mocked(deleteChatConversation).mockReturnValue(new Promise(resolve => { finish = () => resolve(undefined) }))
    const confirm = deletionConfirmation(alert)
    act(() => { confirm(); confirm() })
    expect(deleteChatConversation).toHaveBeenCalledTimes(1)
    expect(deleteChatConversation).toHaveBeenCalledWith('verified', 'owner@example.com', record.id, expect.any(AbortSignal))
    expect(screen.getByLabelText('대화 열기: 삭제할 대화')).toBeTruthy()
    expect(screen.getByLabelText('대화 기록 닫기').props.accessibilityState.disabled).toBe(true)
    await act(async () => finish())
    expect(screen.queryByLabelText('대화 열기: 삭제할 대화')).toBeNull()
    expect(screen.getByLabelText('대화 열기: 다른 기록')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('대화 기록 닫기'))
    expect(screen.queryByText('삭제할 대화')).toBeNull()
    expect(screen.getByText('우리 회사에 맞는 지원사업,')).toBeTruthy()
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    expect(client.search).not.toHaveBeenCalled()
  })

  test('deleting a different record preserves the active conversation and its save version', async () => {
    const alert = jest.spyOn(Alert, 'alert')
    const { record } = await recordedConversation()
    fireEvent.press(screen.getByLabelText('대화 삭제: 다른 기록'))
    await act(async () => deletionConfirmation(alert)())
    expect(screen.queryByLabelText('대화 열기: 다른 기록')).toBeNull()
    expect(screen.getByLabelText('대화 열기: 삭제할 대화')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('대화 기록 닫기'))
    expect(screen.getByText('삭제할 대화')).toBeTruthy()
    await sendQuestion('이어서 질문')
    expect(jest.mocked(saveChatConversation).mock.calls.at(-1)!.slice(2, 4)).toEqual([record.id, 1])
  })

  test('a deletion failure retains the record and conversation and allows retry', async () => {
    const alert = jest.spyOn(Alert, 'alert')
    await recordedConversation()
    jest.mocked(deleteChatConversation).mockRejectedValueOnce(new Error('offline'))
    fireEvent.press(screen.getByLabelText('대화 삭제: 삭제할 대화'))
    await act(async () => deletionConfirmation(alert)())
    expect(screen.getByText('대화 기록을 삭제하지 못했어요. 기록은 유지됩니다. 다시 삭제해 주세요.')).toBeTruthy()
    expect(screen.getByLabelText('대화 열기: 삭제할 대화')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('대화 삭제: 삭제할 대화'))
    await act(async () => deletionConfirmation(alert)())
    expect(screen.queryByLabelText('대화 열기: 삭제할 대화')).toBeNull()
  })

  test.each(['confirmation', 'request'] as const)('account changes discard the old %s before it can alter another account', async stage => {
    const alert = jest.spyOn(Alert, 'alert')
    const { view, props } = await recordedConversation()
    let finish!: () => void
    jest.mocked(deleteChatConversation).mockReturnValue(new Promise(resolve => { finish = () => resolve(undefined) }))
    fireEvent.press(screen.getByLabelText('대화 삭제: 삭제할 대화'))
    const confirm = deletionConfirmation(alert)
    if (stage === 'request') act(confirm)
    jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'another', account: { email: 'another@example.com' } } } as ReturnType<typeof useAuth>)
    view.rerender(<ChatScreen {...props} />)
    if (stage === 'confirmation') {
      act(confirm)
      expect(deleteChatConversation).not.toHaveBeenCalled()
    } else {
      expect(jest.mocked(deleteChatConversation).mock.calls[0][3]!.aborted).toBe(true)
      await act(async () => finish())
    }
    expect(screen.queryByLabelText('대화 열기: 삭제할 대화')).toBeNull()
    expect(screen.getByText('우리 회사에 맞는 지원사업,')).toBeTruthy()
  })
})

function historyClient() {
  const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, answer: '조건을 확인해 주세요.', clarificationQuestion: null, changedFields: [] }),
    getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }), search: jest.fn().mockResolvedValue(full) }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  return client
}

async function sendQuestion(text: string) {
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), text)
  await act(async () => { fireEvent.press(screen.getByLabelText('AI에게 보내기')) })
}

test('each result stays before the next question and earlier recommendations remain after a second search', async () => {
  const client = historyClient()
  client.search.mockResolvedValueOnce({ ...full, programs: [programs[0]] }).mockResolvedValueOnce({ ...full, programs: [programs[1]] })
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await sendQuestion('첫 질문')
  await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
  await sendQuestion('두 번째 질문')
  const contents = within(screen.getByTestId('ai-search-timeline')).getAllByText(/^(첫 질문|두 번째 질문|추천 사업 0)$/).map(node => node.props.children)
  expect(contents).toEqual(['첫 질문', '추천 사업 0', '두 번째 질문'])
  await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
  expect(screen.getByText('추천 사업 0')).toBeTruthy()
  expect(screen.getByText('추천 사업 1')).toBeTruthy()
  expect(screen.getByTestId('ai-search-previous-results')).toBeTruthy()
  expect(saveChatConversation).not.toHaveBeenCalled()
})

test('saved history survives a remount and opens questions, proposals and results without new AI calls', async () => {
  signIn()
  const client = historyClient()
  const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
  let view = render(<ChatScreen {...props} />)
  await sendQuestion('저장할 질문')
  await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
  const saved = jest.mocked(saveChatConversation).mock.calls.at(-1)!
  expect(saved.slice(0, 2)).toEqual(['verified', 'owner@example.com'])
  expect(saved[3]).toBe(1)
  const summary = { id: saved[2], title: '저장할 질문', version: 2, updatedAt: '2026-10-08T09:00:00' }
  jest.mocked(listChatConversations).mockResolvedValue({ items: [summary], nextCursor: null })
  jest.mocked(getChatConversation).mockResolvedValue({ conversation: summary, snapshot: saved[4] })
  view.unmount(); view = render(<ChatScreen {...props} />)
  fireEvent.press(screen.getByLabelText('대화 기록'))
  fireEvent.press(await screen.findByLabelText('대화 열기: 저장할 질문'))
  await screen.findByText('추천 사업 4')
  expect(screen.getByText('저장할 질문')).toBeTruthy()
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
  expect(client.search).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('새 대화'))
  expect(screen.queryByText('저장할 질문')).toBeNull()
  expect(screen.queryByText('추천 사업 4')).toBeNull()
  await sendQuestion('새로운 대화')
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![3]).toBe(0)
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![2]).not.toBe(saved[2])
  view.unmount()
})

test('a failed history save keeps the conversation and retries the same snapshot without another AI call', async () => {
  signIn()
  const client = historyClient()
  jest.mocked(saveChatConversation).mockRejectedValueOnce(new Error('offline'))
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await sendQuestion('저장 실패 질문')
  await screen.findByLabelText('대화 다시 저장')
  expect(screen.getByText('저장 실패 질문')).toBeTruthy()
  const snapshot = jest.mocked(saveChatConversation).mock.calls[0][4]
  await act(async () => { fireEvent.press(screen.getByLabelText('대화 다시 저장')) })
  expect(jest.mocked(saveChatConversation).mock.calls[1][4]).toBe(snapshot)
  expect(screen.queryByLabelText('대화 다시 저장')).toBeNull()
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
})

test('a previous account history response is discarded on account change', async () => {
  signIn(); historyClient()
  let finish!: (page: Awaited<ReturnType<typeof listChatConversations>>) => void
  jest.mocked(listChatConversations).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
  const view = render(<ChatScreen {...props} />)
  fireEvent.press(screen.getByLabelText('대화 기록'))
  const signal = jest.mocked(listChatConversations).mock.calls[0][3]!
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'another', account: { email: 'another@example.com' } } } as ReturnType<typeof useAuth>)
  view.rerender(<ChatScreen {...props} />)
  await act(async () => finish({ items: [{ id: 'old', title: '이전 계정 비공개 기록', version: 1, updatedAt: '2026-10-08T09:00:00' }], nextCursor: null }))
  expect(signal.aborted).toBe(true)
  expect(screen.queryByLabelText('대화 열기: 이전 계정 비공개 기록')).toBeNull()
})
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn(), errorMessage: () => '요청 실패' }))

function usageResponses(...responses: (PlanUsage | Error)[]) {
  const usage = jest.fn<Promise<PlanUsage>, [AbortSignal?]>()
  for (const response of responses) {
    usage.mockImplementationOnce(() => response instanceof Error ? Promise.reject(response) : Promise.resolve(response))
  }
  usage.mockImplementation(() => new Promise<PlanUsage>(() => undefined))
  jest.mocked(planUsageUseCase).mockReturnValue({ usage } as unknown as ReturnType<typeof planUsageUseCase>)
  return usage
}
const searchUsage = (used: number, plan: PlanUsage['plan'] = 'FREE'): PlanUsage => ({ plan, items: [
  { feature: 'AI_SEARCH', period: 'DAY', limit: plan === null ? 2 : plan === 'FREE' ? 10 : null, used, resetsAt: '2026-10-09T00:00:00+09:00' },
  { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used: 0, resetsAt: '2026-10-09T00:00:00+09:00' },
] })

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
async function guestSearch(restoreSearch = jest.fn().mockResolvedValue(full), action: 'login' | 'signup' = 'login') {
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
  await screen.findByLabelText('로그인하고 이번 추천 보기')
  expect(screen.queryByText('추천 사업 2')).toBeNull()
  fireEvent.press(screen.getByLabelText(action === 'signup' ? '회원가입하고 이번 추천 보기' : '로그인하고 이번 추천 보기'))
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
  expect(screen.getByLabelText('새 대화')).toBeTruthy()
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
  expect(screen.queryByText('이번 추천에 3건이 더 있어요')).toBeNull()
})

test('guest signup reports the actual recommendation count and restores the same result after authentication', async () => {
  const { client, view, props, login } = await guestSearch(undefined, 'signup')
  expect(screen.getByText('이번 추천에 3건이 더 있어요')).toBeTruthy()
  expect(screen.getByText('로그인하면 이번 추천 5건을 같은 검색에서 확인할 수 있어요.')).toBeTruthy()
  expect(login).toHaveBeenCalledWith(expect.objectContaining({ direct: true, mode: 'signup' }))
  signIn(); view.rerender(<ChatScreen {...props} />)
  await screen.findByText('추천 사업 4')
  expect(client.restoreSearch).toHaveBeenCalledWith(resultToken, expect.any(AbortSignal))
  expect(client.search).toHaveBeenCalledTimes(1)
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
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

describe('AI search plan usage', () => {
  function readyClient() {
    const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: [] }),
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
      search: jest.fn().mockResolvedValue({ query: context.query, totalCount: 0, programs: [], resultToken: null, expiresAt: null }) }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    return client
  }
  async function propose() {
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    await screen.findByText('이 조건으로 검색할까요?')
  }
  const color = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style).color

  test('guests see their trial count and nothing is shown when usage cannot be read', async () => {
    readyClient()
    usageResponses(searchUsage(1, null))
    const view = render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await screen.findByText('로그인 전 체험 오늘 1/2회')
    expect(color('로그인 전 체험 오늘 1/2회')).toBe(colors.muted)
    expect(planUsageUseCase).toHaveBeenCalledWith(undefined)
    view.unmount()

    const usage = usageResponses(new Error('offline'))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(1))
    await propose()
    expect(screen.queryByTestId('ai-search-usage')).toBeNull()
    expect(screen.getByLabelText('이 조건으로 검색')).toBeEnabled()
  })

  test('the count turns into a warning with the reset time from 80% and reloads after each search', async () => {
    signIn()
    const client = readyClient()
    const usage = usageResponses(searchUsage(7), searchUsage(8))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await screen.findByText('AI 대화 검색 오늘 7/10회')
    expect(color('AI 대화 검색 오늘 7/10회')).toBe(colors.muted)
    expect(planUsageUseCase).toHaveBeenCalledWith('verified')
    await propose()
    expect(usage).toHaveBeenCalledTimes(1)
    // 검색 뒤 이용량을 다시 읽는 비동기 흐름까지 끝낸 뒤 확인합니다.
    await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
    await screen.findByText('AI 대화 검색 오늘 8/10회 · 자정(서울 시간)에 다시 채워져요.')
    expect(color('AI 대화 검색 오늘 8/10회 · 자정(서울 시간)에 다시 채워져요.')).toBe(colors.warning)
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['FREE', 10, '오늘 AI 대화 검색 10회를 모두 썼어요. 자정(서울 시간)에 다시 채워져요. 필터 검색은 계속 쓸 수 있어요.'],
    [null, 2, '로그인 전 체험 2회를 모두 썼어요. 로그인하면 회원 한도로 이어서 검색할 수 있고, 필터 검색은 계속 쓸 수 있어요.'],
  ] as const)('a used-up %s limit explains itself and blocks only the paid search', async (plan, used, message) => {
    if (plan) signIn()
    const client = readyClient()
    usageResponses(searchUsage(used, plan))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await screen.findByText(message)
    expect(color(message)).toBe(colors.warning)
    await propose()
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('조건 바꾸기')).toBeEnabled()
    expect(screen.getByLabelText('이 조건으로 검색')).toBeDisabled()
    fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
    expect(client.getSearchReadiness).not.toHaveBeenCalled()
    expect(client.search).not.toHaveBeenCalled()
    expect(screen.queryByText(/업그레이드|요금제 보기|결제/)).toBeNull()
  })

  test('a plan without a limit yet shows no usage line and never blocks the search', async () => {
    signIn()
    const client = readyClient()
    const usage = usageResponses(searchUsage(500, 'PREMIUM'))
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(1))
    await propose()
    expect(screen.queryByTestId('ai-search-usage')).toBeNull()
    expect(screen.queryByText(/오늘 \d+/)).toBeNull()
    await act(async () => { fireEvent.press(screen.getByLabelText('이 조건으로 검색')) })
    expect(client.search).toHaveBeenCalledTimes(1)
  })
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

test('a server retry delay disables AI requests until the delay ends without automatic retry', async () => {
  jest.useFakeTimers()
  try {
    const client = { interpretConversation: jest.fn().mockRejectedValueOnce(new SupportProgramRequestApiError('SUPPORT_PROGRAM_RATE_LIMITED', 20))
      .mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: [] }) }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '유지할 조건')
    fireEvent.press(screen.getByLabelText('AI에게 보내기'))
    await screen.findByLabelText('20초 후 다시 시도')
    expect(screen.getByLabelText('회사 상황이나 궁금한 점').props.value).toBe('유지할 조건')
    expect(screen.getByLabelText('20초 후 다시 시도').props.accessibilityState.disabled).toBe(true)
    await act(async () => jest.advanceTimersByTime(20_000))
    expect(client.interpretConversation).toHaveBeenCalledTimes(1)
    fireEvent.press(screen.getByLabelText('다시 시도'))
    await screen.findByLabelText('이 조건으로 검색')
    expect(client.interpretConversation).toHaveBeenCalledTimes(2)
  } finally { jest.useRealTimers() }
})

test('an unconfirmed search timeout needs explicit consent before a new request', async () => {
  const alert = jest.spyOn(Alert, 'alert')
  try {
    const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: [] }),
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
      search: jest.fn().mockRejectedValueOnce(new SupportProgramSearchTimeoutApiError()).mockResolvedValue({ query: context.query, totalCount: 0, programs: [], resultToken: null, expiresAt: null }) }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    await sendQuestion('시간 초과 조건')
    fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
    await screen.findByLabelText('다시 시도')
    fireEvent.press(screen.getByLabelText('다시 시도'))
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith('같은 요청을 다시 보낼까요?', expect.any(String), expect.any(Array))
    const confirm = alert.mock.calls.at(-1)![2]!.find(button => button.text === '새 요청으로 다시 시도')!.onPress!
    act(() => confirm())
    await waitFor(() => expect(client.search).toHaveBeenCalledTimes(2))
  } finally { alert.mockRestore() }
})

test('a search accepted before restore failure retries the stored result without another search', async () => {
  signIn()
  const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: [] }),
    getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' }),
    search: jest.fn().mockResolvedValue({ ...full, programs: programs.slice(0, 2), resultToken, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    restoreSearch: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(full) }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await sendQuestion('저장된 결과 확인')
  fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
  await screen.findByLabelText('검색 결과 다시 불러오기')
  expect(screen.queryByLabelText('다시 시도')).toBeNull()
  fireEvent.press(screen.getByLabelText('검색 결과 다시 불러오기'))
  await waitFor(() => expect(client.restoreSearch).toHaveBeenCalledTimes(2))
  expect(client.search).toHaveBeenCalledTimes(1)
})

test('search readiness failures keep the proposal and retry only after a manual request', async () => {
  const client = historyClient()
  client.getSearchReadiness.mockResolvedValueOnce({ indexReady: false, searchState: 'BUILDING' })
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await sendQuestion('준비 상태 확인')
  fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
  await screen.findByText('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
  expect(client.search).not.toHaveBeenCalled()
  expect(client.getSearchReadiness).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('이 조건으로 검색')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('다시 시도'))
  await screen.findByText('추천 사업 4')
  expect(client.getSearchReadiness).toHaveBeenCalledTimes(2)
  expect(client.search).toHaveBeenCalledTimes(1)
})

test('an account change discards a pending unconfirmed retry confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert')
  try {
    signIn()
    const client = historyClient()
    client.search.mockRejectedValue(new TypeError('Network request failed'))
    const props = { onOpenProgram: jest.fn(), onLogin: jest.fn() }
    const view = render(<ChatScreen {...props} />)
    await sendQuestion('연결 종료 조건')
    fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
    await screen.findByLabelText('다시 시도')
    fireEvent.press(screen.getByLabelText('다시 시도'))
    const confirm = alert.mock.calls.at(-1)![2]!.find(button => button.text === '새 요청으로 다시 시도')!.onPress!
    jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'another', account: { email: 'another@example.com' } } } as ReturnType<typeof useAuth>)
    view.rerender(<ChatScreen {...props} />)
    act(() => confirm())
    expect(client.search).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('다시 시도')).toBeNull()
  } finally { alert.mockRestore() }
})

test('opening another saved proposal clears the previous unconfirmed retry without rerunning AI', async () => {
  signIn()
  const client = historyClient()
  client.search.mockRejectedValue(new SupportProgramSearchTimeoutApiError())
  render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
  await sendQuestion('저장할 조건')
  const saved = jest.mocked(saveChatConversation).mock.calls[0]
  const record = { id: saved[2], title: '저장할 조건', version: 1, updatedAt: '2026-10-08T09:00:00' }
  jest.mocked(listChatConversations).mockResolvedValue({ items: [record], nextCursor: null })
  jest.mocked(getChatConversation).mockResolvedValue({ conversation: record, snapshot: saved[4] })
  fireEvent.press(screen.getByLabelText('이 조건으로 검색'))
  await screen.findByLabelText('다시 시도')
  expect(screen.getByLabelText('이 조건으로 검색').props.accessibilityState.disabled).toBe(true)
  fireEvent.press(screen.getByLabelText('대화 기록'))
  fireEvent.press(await screen.findByLabelText('대화 열기: 저장할 조건'))
  await screen.findByText(/이전 대화의 추천 공고는 저장 당시 정보예요/)
  expect(screen.getByLabelText('이 조건으로 검색').props.accessibilityState.disabled).toBe(false)
  expect(screen.queryByLabelText('다시 시도')).toBeNull()
  expect(client.search).toHaveBeenCalledTimes(1)
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
})
