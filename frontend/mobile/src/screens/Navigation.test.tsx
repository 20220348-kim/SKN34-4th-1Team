import { Text } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import TabLayout from '../../app/(tabs)/_layout'
import SearchRoute from '../../app/(tabs)/index'
import ChatRoute from '../../app/(tabs)/chat'
import CollaborationRoute from '../../app/(tabs)/collab'
import ReportRoute from '../../app/(tabs)/report'
import SavedRoute from '../../app/(tabs)/saved'
import AccountRoute from '../../app/(tabs)/account'
import { programClient } from '../api/client'

jest.mock('../auth/session', () => ({ useAuth: () => ({ status: 'signedOut', session: null, restoreError: null }) }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: () => false }))

function ProgramDestination() {
  const params = useLocalSearchParams()
  return <Text>{params.sourceCode}:{params.sourceProgramId}</Text>
}
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>,
  '(tabs)/_layout': TabLayout, '(tabs)/index': SearchRoute, '(tabs)/chat': ChatRoute,
  '(tabs)/collab': CollaborationRoute, '(tabs)/report': ReportRoute,
  '(tabs)/saved': SavedRoute, '(tabs)/account': AccountRoute, program: ProgramDestination,
}

beforeEach(() => {
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({
    programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
    startupStages: [], applicantTypes: [], founderAges: [],
  }) } as unknown as ReturnType<typeof programClient>)
})

test('five visible destinations retain their order and expose preparation notices, saved login gate and account login', async () => {
  renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(screen.getAllByLabelText(/^(검색|관심함|협업|리포트|내 정보)$/).map((tab) => tab.props.accessibilityLabel))
    .toEqual(['검색', '관심함', '협업', '리포트', '내 정보'])
  expect(screen.queryByText('AI 대화')).toBeNull()
  fireEvent.press(screen.getByLabelText('협업'))
  await screen.findByText('협업 공간을 준비하고 있어요')
  fireEvent.press(screen.getByLabelText('리포트'))
  await screen.findByText('맞춤 리포트를 준비하고 있어요')
  fireEvent.press(screen.getByLabelText('관심함'))
  await screen.findByText('내 정보 탭에서 로그인하면 웹과 앱에 저장한 관심 공고를 볼 수 있습니다.')
  fireEvent.press(screen.getByLabelText('내 정보'))
  await screen.findByLabelText('이메일')
}, 15_000)

test('legacy chat links redirect to AI search without a sixth visible destination', async () => {
  const view = renderRouter(routes, { initialUrl: '/chat' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(view.getSearchParams()).toMatchObject({ mode: 'ai' })
})

test('filter links and returning from a detail keep the selected search mode and input', async () => {
  const view = renderRouter(routes, { initialUrl: '/?mode=filter' })
  await screen.findByText('검색 결과 0건')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '유지할 조건')
  await act(async () => router.push({ pathname: '/program', params: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' } }))
  await screen.findByText('BIZINFO:PBLN_1')
  await act(async () => router.back())
  await screen.findByDisplayValue('유지할 조건')
  expect(view.getSearchParams()).toMatchObject({ mode: 'filter' })
  fireEvent.press(screen.getByRole('tab', { name: 'AI 검색' }))
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(view.getSearchParams()).toMatchObject({ mode: 'ai' })
})
