import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { Stack, Tabs } from 'expo-router'
import { renderRouter } from 'expo-router/testing-library'
import { Alert } from 'react-native'
import SearchRoute from '../../app/(tabs)/index'
import { useAuth } from '../auth/session'
import { programClient } from '../api/client'
import { listChatConversations, saveChatConversation } from '../api/chatConversations'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => jest.fn() }))
jest.mock('../assistant/context', () => ({ ...jest.requireActual('../assistant/context'), useAssistant: () => ({ searchDraft: null, consumeSearchDraft: jest.fn() }) }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../api/planUsage', () => ({ planUsageUseCase: () => ({ usage: () => new Promise(() => undefined) }) }))
jest.mock('../api/savedPrograms', () => ({ listSavedPrograms: jest.fn().mockResolvedValue([]) }))
jest.mock('../api/chatConversations', () => ({
  listChatConversations: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  saveChatConversation: jest.fn().mockImplementation(async (_token, _email, id, version) => ({ id, title: '검색 기록', version: version + 1, updatedAt: '2026-10-14T09:00:00' })),
}))
let mockMessageNumber = 0
jest.mock('expo-crypto', () => ({ randomUUID: () => `header-conversation-${++mockMessageNumber}` }))

beforeEach(() => {
  mockMessageNumber = 0
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@example.com', role: 'USER' } } } as ReturnType<typeof useAuth>)
})
afterEach(() => jest.restoreAllMocks())

const routes = {
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none' }}><Tabs.Screen name="index" options={{ headerTitle: '지원사업 검색' }} /></Tabs>,
  '(tabs)/index': SearchRoute,
}

test('header actions open records, follow busy state and confirm a new conversation across search modes', async () => {
  let resolveReply!: (value: unknown) => void
  const client = {
    interpretConversation: jest.fn(() => new Promise(resolve => { resolveReply = resolve })),
    browseCatalog: jest.fn().mockResolvedValue({ programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [] }),
  }
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  renderRouter(routes, { initialUrl: '/?mode=ai' })
  await screen.findByLabelText('대화 기록')
  expect(screen.getByText('지원사업 검색')).toBeTruthy()
  expect(within(screen.getByTestId('search-panel-ai')).queryByLabelText('대화 기록')).toBeNull()
  expect(within(screen.getByTestId('search-panel-ai')).queryByLabelText('새 대화')).toBeNull()

  await act(async () => fireEvent.press(screen.getByLabelText('대화 기록')))
  expect(listChatConversations).toHaveBeenCalledWith('owner', 'owner@example.com', null, expect.any(AbortSignal))
  fireEvent.press(screen.getByLabelText('대화 기록 닫기'))
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  expect(screen.getByLabelText('대화 기록')).toBeDisabled()
  expect(screen.getByLabelText('새 대화')).toBeDisabled()
  jest.mocked(saveChatConversation).mockRejectedValueOnce(new Error('offline'))
  await act(async () => resolveReply({ status: 'CLARIFICATION_REQUIRED', proposedContext: null, clarificationQuestion: '어떤 지원이 필요한가요?', changedFields: [] }))
  await waitFor(() => expect(screen.getByLabelText('새 대화')).toBeEnabled())

  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  await screen.findByText('검색 결과 0건')
  expect(screen.queryByLabelText('대화 기록')).toBeNull()
  expect(screen.queryByLabelText('새 대화')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
  await screen.findByLabelText('대화 기록')
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)

  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '아직 보내지 않은 질문')
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  fireEvent.press(screen.getByLabelText('새 대화'))
  expect(screen.getByDisplayValue('아직 보내지 않은 질문')).toBeTruthy()
  const buttons = alert.mock.calls.at(-1)![2]!
  act(() => buttons.find(button => button.style !== 'cancel')!.onPress!())
  expect(screen.getByLabelText('회사 상황이나 궁금한 점')).toHaveDisplayValue('')
  expect(screen.queryByText('어떤 지원이 필요한가요?')).toBeNull()
  expect(client.interpretConversation).toHaveBeenCalledTimes(1)
})

test('a guest keeps login in the header and gains new conversation after a question', async () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  jest.mocked(programClient).mockReturnValue({ interpretConversation: jest.fn().mockResolvedValue({
    status: 'CLARIFICATION_REQUIRED', proposedContext: null, clarificationQuestion: '어떤 지원이 필요한가요?', changedFields: [],
  }) } as unknown as ReturnType<typeof programClient>)
  renderRouter(routes, { initialUrl: '/?mode=ai' })
  expect(await screen.findByLabelText('로그인')).toBeTruthy()
  expect(screen.queryByLabelText('대화 기록')).toBeNull()
  expect(screen.queryByLabelText('새 대화')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '지원사업')
  await act(async () => fireEvent.press(screen.getByLabelText('AI에게 보내기')))
  expect(screen.getByLabelText('새 대화')).toBeEnabled()
  expect(within(screen.getByTestId('search-panel-ai')).queryByLabelText('새 대화')).toBeNull()
  expect(screen.queryByLabelText('대화 기록')).toBeNull()
})
