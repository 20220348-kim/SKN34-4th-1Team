import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { router } from 'expo-router'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { preparation, review, run } from '../test/preparationFixtures'
import { PreparationScreen } from './PreparationScreen'

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: (effect: () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect])
} }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const invalidateSession = jest.fn()
function signedIn(accessToken: string) {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken }, invalidateSession } as unknown as ReturnType<typeof useAuth>)
}
function respond(path: string) {
  if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation], nextBeforeId: null })
  if (path.startsWith('/api/v1/combination-reviews?')) return Promise.resolve({ items: [review], nextBeforeId: null })
  if (path === '/api/v1/combination-reviews/5') return Promise.resolve(review)
  if (path === '/api/v1/combination-reviews/5/runs?size=1') return Promise.resolve({ items: [run], nextBeforeId: null })
  throw new Error('Unexpected request ' + path)
}
beforeEach(() => {
  signedIn('owned-token')
  jest.mocked(apiRequest).mockReset().mockImplementation(respond)
})

test.each(['documents', 'reviews'] as const)('%s displays its own API list and opens the corresponding web/native detail', async (kind) => {
  process.env.EXPO_PUBLIC_WEB_BASE_URL = 'https://govbiz.example.test'
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  try {
    render(<PreparationScreen kind={kind} onLogin={jest.fn()} />)
    await screen.findByText(kind === 'documents' ? '신청 문서 1건' : '중복 검토 1건')
    const row = kind === 'documents' ? '사업계획서 · 일반 신청 열기' : '동시 신청 검토 열기'
    if (kind === 'documents') expect(screen.queryByLabelText('동시 신청 검토 열기')).toBeNull()
    else expect(screen.queryByText(/사업계획서/)).toBeNull()
    fireEvent.press(screen.getByLabelText(row))
    if (kind === 'documents') await waitFor(() => expect(open).toHaveBeenCalledWith('https://govbiz.example.test/app/application-preparations/9'))
    else {
      expect(router.push).toHaveBeenCalledWith({ pathname: '/all/reviews/[id]', params: { id: '5', runId: '6' } })
      expect(open).not.toHaveBeenCalled()
    }
    expect(apiRequest).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/v1\//), expect.objectContaining({ accessToken: 'owned-token' }))
    expect(jest.mocked(apiRequest).mock.calls.every(([, options]) => !options?.method)).toBe(true)
  } finally { open.mockRestore(); delete process.env.EXPO_PUBLIC_WEB_BASE_URL }
})

test('a list failure shows an error rather than a normal empty list', async () => {
  jest.mocked(apiRequest).mockRejectedValue(new Error('조회 실패'))
  render(<PreparationScreen kind="documents" onLogin={jest.fn()} />)
  await screen.findByLabelText('다시 확인')
  expect(screen.queryByText('아직 신청 문서가 없습니다.')).toBeNull()
  expect(screen.queryByText('신청 문서 0건')).toBeNull()
})

test('a late previous account response cannot reveal preparation data', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (options?.accessToken === 'second-token') return Promise.resolve({ items: [], nextBeforeId: null })
    if (path.startsWith('/api/v1/application-preparations?')) return new Promise((resolve) => { finish = resolve })
    return Promise.resolve({ items: [], nextBeforeId: null })
  })
  const view = render(<PreparationScreen kind="documents" onLogin={jest.fn()} />)
  await waitFor(() => expect(finish).toBeDefined())
  signedIn('second-token')
  view.rerender(<PreparationScreen kind="documents" onLogin={jest.fn()} />)
  await act(async () => finish({ items: [preparation], nextBeforeId: null }))
  await screen.findByText('아직 신청 문서가 없습니다.')
  expect(screen.queryByText(/사업계획서/)).toBeNull()
})
