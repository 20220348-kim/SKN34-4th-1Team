import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
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
  expect(screen.getByText('우리 회사의 다음 기회,')).toBeTruthy()
  expect(screen.getByText('말로 찾아보세요')).toBeTruthy()
  expect(screen.getByTestId('ai-search-composer')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '입력 중')
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(client.search).not.toHaveBeenCalled()
})
