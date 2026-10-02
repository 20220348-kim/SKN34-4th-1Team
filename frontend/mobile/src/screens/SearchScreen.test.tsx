import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { programClient } from '../api/client'
import { useAuth } from '../auth/session'
import { SearchScreen, type SearchMode } from './SearchScreen'

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
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '입력 중인 필터')
  fireEvent.press(screen.getByRole('tab', { name: 'AI 검색' }))
  expect(screen.getByDisplayValue('이어서 작성 중')).toBeTruthy()
  expect(screen.getByText('이 조건으로 검색할까요?')).toBeTruthy()
  expect(screen.queryByLabelText('공고명·기관명')).toBeNull()
  expect(screen.getByRole('tab', { name: 'AI 검색' })).toBeSelected()
  fireEvent.press(screen.getByRole('tab', { name: '필터 검색' }))
  expect(screen.getByDisplayValue('입력 중인 필터')).toBeTruthy()
  expect(client.browseCatalog).toHaveBeenCalledTimes(1)
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
  fireEvent.press(screen.getByRole('tab', { name: 'AI 검색' }))
  expect(screen.queryByText('이전 계정 답변')).toBeNull()
  expect(screen.queryByText('이 조건으로 검색할까요?')).toBeNull()
  expect(screen.getByLabelText('회사 상황이나 궁금한 점').props.value).toBe('')
})
