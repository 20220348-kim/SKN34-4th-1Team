import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { SavedProgramsScreen } from './SavedProgramsScreen'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => { const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect]) } }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ apiRequest: jest.fn(), ApiError: class extends Error {}, errorMessage: () => '요청을 처리하지 못했습니다.' }))
const invalidateSession = jest.fn()
const auth = (accessToken: string) => ({ session: { accessToken }, status: 'signedIn', invalidateSession, refreshSession: jest.fn() })
const program = { sourceCode: 'BIZINFO', id: 'P/123', title: '테스트 지원사업', organization: '기관', summary: '요약', categories: [], regions: [], targetDescription: '기업', applicationPeriod: '상시', applicationStartDate: null, applicationEndDate: null, status: 'OPEN', sourceName: '기업마당', sourceUrl: 'https://www.bizinfo.go.kr/program', matchedReasons: [], recommendationScore: null, eligibilityReview: null }

beforeEach(() => { jest.mocked(apiRequest).mockReset(); jest.mocked(useAuth).mockReturnValue(auth('first-token') as unknown as ReturnType<typeof useAuth>) })

test('a delayed response from a previous account cannot reveal its saved programs', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValueOnce({ programs: [] })
  const view = render(<SavedProgramsScreen onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1))
  jest.mocked(useAuth).mockReturnValue(auth('second-token') as unknown as ReturnType<typeof useAuth>)
  view.rerender(<SavedProgramsScreen onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2))
  await act(async () => finish({ programs: [{ savedAt: '2026-09-19', program }] }))
  expect(view.queryByText('테스트 지원사업')).toBeNull()
  expect(view.getByText(/아직 관심 공고가 없습니다/)).toBeTruthy()
})

test('saved program navigation preserves source and source-local identity', async () => {
  jest.mocked(apiRequest).mockResolvedValueOnce({ programs: [{ savedAt: '2026-09-19', program }] })
  const open = jest.fn()
  const view = render(<SavedProgramsScreen onOpenProgram={open} />)
  await waitFor(() => expect(view.getByText('테스트 지원사업')).toBeTruthy())
  fireEvent.press(view.getByText('공고 상세'))
  expect(open).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' })
})
