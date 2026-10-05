import { fireEvent, waitFor } from '@testing-library/react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { SavedProgramsScreen } from './SavedProgramsScreen'
import NewPreparationRoute from '../../app/(tabs)/all/preparation/new'
import NewReviewRoute from '../../app/(tabs)/all/reviews/new'

const mockDocumentEntry = jest.fn(), mockReviewEntry = jest.fn()
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
// 실제 작성 라우트의 매개변수를 검증하며 목적지의 작성 UI·API 실행은 별도 화면 테스트에 맡깁니다.
jest.mock('./ApplicationPreparationNewScreen', () => ({ ApplicationPreparationNewScreen: (props: { initialProgram?: unknown }) => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native')
  mockDocumentEntry(props); return <Text>신청 문서 공고 선택</Text>
} }))
jest.mock('./CombinationReviewScreens', () => ({ CombinationReviewEditorScreen: (props: { id: number | null; initialProgram?: unknown }) => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native')
  mockReviewEntry(props); return <Text>중복 검토 공고 선택</Text>
} }))

beforeEach(() => {
  mockDocumentEntry.mockReset(); mockReviewEntry.mockReset()
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner' }, invalidateSession: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(apiRequest).mockReset().mockImplementation(path => Promise.resolve(path === '/api/v1/me/saved-programs' ? { programs: [] } : { items: [], nextBeforeId: null }))
})

test.each([
  ['새 신청문서', '/all/preparation/new', '신청 문서 공고 선택'],
  ['새 검토', '/all/reviews/new', '중복 검토 공고 선택'],
])('empty workspace %s opens the existing route without an invented program', async (label, path, title) => {
  const view = renderRouter({ _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
    index: () => <SavedProgramsScreen onLogin={jest.fn()} onOpenProgram={identity => router.push({ pathname: '/program', params: identity })} />,
    'all/preparation/new': NewPreparationRoute, 'all/reviews/new': NewReviewRoute,
  }, { initialUrl: '/' })
  await screen.findByRole('tab', { name: '준비 중인 작업 0' })
  fireEvent.press(screen.getByRole('tab', { name: '준비 중인 작업 0' }))
  fireEvent.press(screen.getByLabelText(label))
  await screen.findByText(title)
  await waitFor(() => expect(view.getPathname()).toBe(path))
  const entry = path.includes('preparation') ? mockDocumentEntry : mockReviewEntry
  expect(entry).toHaveBeenLastCalledWith(expect.objectContaining({ initialProgram: undefined }))
  if (path.includes('reviews')) expect(entry).toHaveBeenLastCalledWith(expect.objectContaining({ id: null }))
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'POST' || options?.method === 'PUT')).toBe(false)
}, 15_000)
