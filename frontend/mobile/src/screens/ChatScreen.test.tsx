import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { ChatScreen } from './ChatScreen'
import { programClient } from '../api/client'

jest.mock('../auth/session', () => ({ useAuth: () => ({ status: 'signedOut', session: null }) }))
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
    fireEvent.press(screen.getByText('AI에게 보내기'))
    await screen.findByText('이 조건으로 검색할까요?')
    expect(client.search).not.toHaveBeenCalled()
    fireEvent.press(screen.getByText('조건 확인 · 공고 검색'))
    await waitFor(() => expect(client.search).toHaveBeenCalledWith({ query: '사업화 지원', acceptingOnly: true, companyConditions: { region: '서울특별시' } }, expect.anything()))
    await screen.findByText('조건에 맞는 공고가 없습니다. 필요한 지원이나 회사 조건을 바꿔 보세요.')
  })

  it('blocks the paid search when the search index is unavailable', async () => {
    const client = { interpretConversation: jest.fn().mockResolvedValue({ status: 'READY', proposedContext: context, clarificationQuestion: null, changedFields: ['QUERY'] }),
      getSearchReadiness: jest.fn().mockResolvedValue({ indexReady: false, searchState: 'PREPARING' }), search: jest.fn() }
    jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
    render(<ChatScreen onOpenProgram={jest.fn()} onLogin={jest.fn()} />)
    fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '사업화 지원')
    fireEvent.press(screen.getByText('AI에게 보내기'))
    await screen.findByText('이 조건으로 검색할까요?')
    fireEvent.press(screen.getByText('조건 확인 · 공고 검색'))
    await screen.findByText('검색 데이터를 준비 중입니다. 잠시 후 다시 검색해 주세요.')
    expect(client.search).not.toHaveBeenCalled()
  })
})
