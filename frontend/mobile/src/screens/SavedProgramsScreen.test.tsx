import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { SavedProgramsScreen } from './SavedProgramsScreen'
import { preparation, programDetail, review, run } from '../test/preparationFixtures'

jest.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => { const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(effect, [effect]) } }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const invalidateSession = jest.fn()
const auth = (accessToken: string) => ({ session: { accessToken }, status: 'signedIn', invalidateSession, refreshSession: jest.fn() })
const saved = { savedAt: '2026-09-19', program: { ...programDetail, matchedReasons: [], recommendationScore: null, eligibilityReview: null } }

function respond(path: string) {
  if (path === '/api/v1/me/saved-programs') return Promise.resolve({ programs: [saved] })
  if (path.startsWith('/api/v1/application-preparations?')) return Promise.resolve({ items: [preparation], nextBeforeId: null })
  if (path.startsWith('/api/v1/combination-reviews?')) return Promise.resolve({ items: [], nextBeforeId: null })
  throw new Error(`Unexpected request ${path}`)
}
beforeEach(() => {
  jest.mocked(apiRequest).mockReset().mockImplementation(respond)
  jest.mocked(useAuth).mockReturnValue(auth('first-token') as unknown as ReturnType<typeof useAuth>)
})

test('a delayed previous account response cannot reveal saved programs or preparation work', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((path, options) => {
    if (options?.accessToken === 'second-token') return Promise.resolve(path === '/api/v1/me/saved-programs' ? { programs: [] } : { items: [], nextBeforeId: null })
    if (path === '/api/v1/me/saved-programs') return new Promise((resolve) => { finish = resolve })
    return respond(path)
  })
  const view = render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await waitFor(() => expect(finish).toBeDefined())
  jest.mocked(useAuth).mockReturnValue(auth('second-token') as unknown as ReturnType<typeof useAuth>)
  view.rerender(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await act(async () => finish({ programs: [saved] }))
  await screen.findByText(/아직 관심 공고가 없습니다/)
  expect(screen.queryByText('테스트 지원사업')).toBeNull()
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 0' }))
  expect(screen.queryByText(/사업계획서/)).toBeNull()
})
test('saved navigation and preparation filters distinguish the full source identity', async () => {
  const other = { ...saved, program: { ...saved.program, sourceCode: 'KSTARTUP', sourceName: 'K-Startup', title: '다른 제공처 공고',
    sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' } }
  jest.mocked(apiRequest).mockImplementation((path) => path === '/api/v1/me/saved-programs' ? Promise.resolve({ programs: [saved, other] }) : respond(path))
  const open = jest.fn()
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={open} />)
  await screen.findByText('다른 제공처 공고')
  await screen.findByText('준비 중 1')
  fireEvent.press(screen.getByLabelText('준비 중 공고 필터'))
  expect(screen.queryByText('다른 제공처 공고')).toBeNull()
  fireEvent.press(screen.getByText('상세 보기'))
  expect(open).toHaveBeenCalledWith({ sourceCode: 'BIZINFO', sourceProgramId: 'P/123' })
})
test('successful removal offers undo and restores the server returned saved date', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE' ? Promise.resolve(undefined)
    : options?.method === 'POST' ? Promise.resolve({ ...saved, savedAt: '2026-10-01' }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 관심 공고에서 빼기'))
  await screen.findByText('관심 공고에서 뺐어요')
  expect(screen.queryByText('테스트 지원사업')).toBeNull()
  fireEvent.press(screen.getByLabelText('되돌리기'))
  await screen.findByText('10.01 담음')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/saved-programs', expect.objectContaining({
    method: 'POST', accessToken: 'first-token', body: { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' },
  }))
})
test('failed removal retains the card and never offers a successful undo notice', async () => {
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE' ? Promise.reject(new Error('offline')) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText('테스트 지원사업')
  fireEvent.press(screen.getByLabelText('테스트 지원사업 관심 공고에서 빼기'))
  await screen.findByText(/연결하지 못했거나/)
  expect(screen.getByText('테스트 지원사업')).toBeTruthy()
  expect(screen.queryByText('관심 공고에서 뺐어요')).toBeNull()
})
test('preparation load errors stay explicit while saved cards remain usable', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/application-preparations?') ? Promise.reject(new Error('offline')) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByText(/신청 문서 조회 실패/)
  expect(screen.getByText('테스트 지원사업')).toBeTruthy()
  expect(screen.getByText('단계 미확인')).toBeTruthy()
  expect(screen.queryByText('관심 1')).toBeNull()
})
test('preparation work uses saved answer counts and current review runs', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/combination-reviews?') ? Promise.resolve({ items: [review], nextBeforeId: null })
    : path.endsWith('/5') ? Promise.resolve(review) : path.includes('/runs?') ? Promise.resolve({ items: [run], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByRole('tab', { name: '준비 중인 작업 2' })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 2' }))
  expect(screen.getByText('3개 항목 중 1개 확인')).toBeTruthy()
  expect(screen.getByText('작성 중')).toBeTruthy()
  expect(screen.getByText('분석 완료')).toBeTruthy()
  expect(screen.queryByText('초안 완료')).toBeNull()
})

test('a running review for previous inputs cannot be shown as the current analysis', async () => {
  jest.mocked(apiRequest).mockImplementation((path) => path.startsWith('/api/v1/combination-reviews?') ? Promise.resolve({ items: [review], nextBeforeId: null })
    : path.endsWith('/5') ? Promise.resolve({ ...review, inputRevision: 2 })
      : path.includes('/runs?') ? Promise.resolve({ items: [{ ...run, status: 'RUNNING', finishedAt: null }], nextBeforeId: null }) : respond(path))
  render(<SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={jest.fn()} />)
  await screen.findByRole('tab', { name: '준비 중인 작업 2' })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 2' }))
  expect(screen.getByText('입력 변경')).toBeTruthy()
  expect(screen.queryByLabelText('중복 검토 진행 중')).toBeNull()
  expect(screen.queryByText('분석 완료')).toBeNull()
})
