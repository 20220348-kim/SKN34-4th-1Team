import { Text } from 'react-native'
import { useState } from 'react'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import TabLayout from '../../app/(tabs)/_layout'
import SearchRoute from '../../app/(tabs)/index'
import ChatRoute from '../../app/(tabs)/chat'
import LegacyCollaborationRoute from '../../app/(tabs)/collab'
import CollaborationRoute from '../../app/(tabs)/all/collab'
import ReportRoute from '../../app/(tabs)/report'
import SavedRoute from '../../app/(tabs)/saved'
import LegacyAccountRoute from '../../app/(tabs)/account'
import AccountRoute from '../../app/(tabs)/all/account'
import AllLayout from '../../app/(tabs)/all/_layout'
import MenuRoute from '../../app/(tabs)/all/index'
import CompanyRoute from '../../app/(tabs)/all/company'
import LegacyCompanyRoute from '../../app/company'
import SettingsRoute from '../../app/(tabs)/all/settings'
import PreparationRoute from '../../app/(tabs)/all/preparation'
import ReviewListRoute from '../../app/(tabs)/all/reviews'
import NewReviewRoute from '../../app/(tabs)/all/reviews/new'
import ReviewRoute from '../../app/(tabs)/all/reviews/[id]'
import { programClient } from '../api/client'
import { browseRecruitments, browseProposals } from '../api/partners'
import { LoginFlowProvider } from '../auth/loginFlow'
import { AppEntryGate } from '../auth/AppEntryGate'
import { completeIntroduction, readIntroductionCompleted } from '../auth/introductionStorage'
import { useAuth } from '../auth/session'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: () => false }))
jest.mock('../auth/introductionStorage', () => ({ completeIntroduction: jest.fn(), readIntroductionCompleted: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), browseRecruitments: jest.fn(), browseProposals: jest.fn() }))

function ProgramDestination() {
  const params = useLocalSearchParams()
  return <Text>{params.sourceCode}:{params.sourceProgramId}</Text>
}
const routes = {
  _layout: () => <LoginFlowProvider><Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack></LoginFlowProvider>,
  '(tabs)/_layout': TabLayout, '(tabs)/index': SearchRoute, '(tabs)/chat': ChatRoute,
  '(tabs)/collab': LegacyCollaborationRoute, '(tabs)/report': ReportRoute,
  '(tabs)/saved': SavedRoute, '(tabs)/account': LegacyAccountRoute, program: ProgramDestination,
  '(tabs)/all/_layout': AllLayout, '(tabs)/all/index': MenuRoute, '(tabs)/all/account': AccountRoute,
  '(tabs)/all/collab': CollaborationRoute, '(tabs)/all/company': CompanyRoute,
  '(tabs)/all/settings': SettingsRoute, '(tabs)/all/preparation': PreparationRoute, company: LegacyCompanyRoute,
  '(tabs)/all/reviews/index': ReviewListRoute, '(tabs)/all/reviews/new': NewReviewRoute, '(tabs)/all/reviews/[id]': ReviewRoute,
}

beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
  jest.mocked(browseProposals).mockResolvedValue({ box: 'received', proposals: [], pendingCount: 0 })
  jest.mocked(readIntroductionCompleted).mockResolvedValue(false)
  jest.mocked(completeIntroduction).mockResolvedValue(undefined)
  jest.mocked(browseRecruitments).mockResolvedValue({ recruitments: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({
    programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
    startupStages: [], applicantTypes: [], founderAges: [],
  }) } as unknown as ReturnType<typeof programClient>)
})

test('the root introduction mounts the actual navigator only after choosing public entry and preserves the incoming search mode', async () => {
  const entryRoutes = { ...routes, _layout: () => <LoginFlowProvider><AppEntryGate><Stack screenOptions={{ animation: 'none' }}>
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack></AppEntryGate></LoginFlowProvider> }
  const view = renderRouter(entryRoutes, { initialUrl: '/?mode=filter' })
  await screen.findByText('맞는 지원사업을 찾아요')
  fireEvent.press(screen.getByLabelText('로그인 없이 둘러보기'))
  await screen.findByLabelText('공고명·기관명')
  expect(view.getSearchParams()).toMatchObject({ mode: 'filter' })
})

const tabLabels = () => screen.getAllByLabelText(/^(검색|협업|관심함|리포트|전체)$/).map(tab => tab.props.accessibilityLabel)
const memberAuth = { status: 'signedIn', session: { accessToken: 'owner', account: { email: 'member@example.com', company: null } },
  restoreError: null, invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>

test('guests have exactly search, collaboration and All and browse public recruitment without private calls', async () => {
  const view = renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(tabLabels()).toEqual(['검색', '협업', '전체'])
  fireEvent.press(screen.getByLabelText('협업'))
  await screen.findByText('모집글 0건')
  expect(view.getPathname()).toBe('/collab')
  expect(browseProposals).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('전체'))
  await screen.findByLabelText('메뉴 검색')
  expect(screen.getByLabelText('신청 문서')).toBeTruthy()
  expect(screen.getByLabelText('관심 공고함')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('내 계정'))
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('로그인 취소'))
  expect(tabLabels()).toEqual(['검색', '협업', '전체'])
}, 15_000)

test('verified members retain the original four tabs and private All menu', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '전체'])
  fireEvent.press(screen.getByLabelText('전체'))
  await screen.findByLabelText('신청 문서')
  expect(screen.getByLabelText('관심 공고함')).toBeTruthy()
})

test('signing in from the guest collaboration tab retains its destination inside the member All stack', async () => {
  const view = renderRouter(routes, { initialUrl: '/collab' })
  await screen.findByText('모집글 0건')
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  await act(async () => router.setParams({ view: 'recruitments' }))
  await waitFor(() => expect(view.getPathname()).toBe('/all/collab'))
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '전체'])
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
})

test('logging out from a hidden member tab returns to public search with three tabs', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const safeRoutes = { ...routes, '(tabs)/saved': () => <Text>회원 관심함 화면</Text> }
  const view = renderRouter(safeRoutes, { initialUrl: '/saved' })
  await screen.findByText('회원 관심함 화면')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
  await act(async () => router.setParams({ check: 'logout' }))
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(tabLabels()).toEqual(['검색', '협업', '전체'])
})

test('guest private menu entries keep All on cancellation and enter the selected feature only after verified login', async () => {
  let verifyLogin!: () => void
  function ReactiveAuthLayout() {
    const [verified, setVerified] = useState(false)
    verifyLogin = () => setVerified(true)
    jest.mocked(useAuth).mockReturnValue(verified ? memberAuth : { status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
    const Layout = routes._layout
    return <Layout />
  }
  const safeRoutes = { ...routes, _layout: ReactiveAuthLayout, '(tabs)/saved': () => <Text>선택한 회원 관심함</Text> }
  const view = renderRouter(safeRoutes, { initialUrl: '/all' })
  await screen.findByLabelText('관심 공고함')
  fireEvent.press(screen.getByLabelText('관심 공고함'))
  expect(screen.getByText('로그인이 필요해요')).toBeTruthy()
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('계속 둘러보기'))
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('관심 공고함'))
  await act(async () => verifyLogin())
  await screen.findByText('선택한 회원 관심함')
  expect(view.getPathname()).toBe('/saved')
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '전체'])
})

test.each([
  ['/account', '/all/account', '이메일'],
  ['/collab?view=box&box=sent', '/collab', '로그인하기'],
  ['/company', '/all/company', '로그인하기'],
])('legacy %s redirects into All', async (initialUrl, pathname, label) => {
  const view = renderRouter(routes, { initialUrl })
  await screen.findByLabelText(label)
  await waitFor(() => expect(view.getPathname()).toBe(pathname))
  expect(screen.getByLabelText(initialUrl.startsWith('/collab') ? '협업' : '전체').props.accessibilityState.selected).toBe(true)
  if (initialUrl.startsWith('/collab')) expect(view.getSearchParams()).toMatchObject({ view: 'box', box: 'sent' })
})

test.each([
  ['리포트 수신 설정', '/all/settings', '로그인하면 리포트 수신 설정을 변경할 수 있어요.'],
  ['신청 문서', '/all/preparation', '로그인하면 신청 문서와 중복 검토를 확인할 수 있어요.'],
  ['중복 검토', '/all/reviews', '로그인하면 본인의 검토와 참여 이력을 관리할 수 있어요. 기업 등록 없이 직접 입력할 수 있습니다.'],
  ['받은 제안', '/all/collab', '제안함은 로그인 후 확인할 수 있어요.'],
  ['보낸 제안', '/all/collab', '제안함은 로그인 후 확인할 수 있어요.'],
  ['내 모집글', '/all/collab', '내 모집글은 로그인 후 확인할 수 있어요.'],
])('All destination %s opens its login gate with All selected', async (label, pathname, notice) => {
  const suffix = label === '받은 제안' ? '?view=box&box=received' : label === '보낸 제안' ? '?view=box&box=sent' : label === '내 모집글' ? '?mine=1' : ''
  const view = renderRouter(routes, { initialUrl: pathname + suffix })
  await screen.findByText(notice)
  expect(view.getPathname()).toBe(pathname)
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
  fireEvent.press(screen.getByLabelText(label === '중복 검토' ? '로그인하고 시작' : '로그인하기'))
  if (label !== '리포트 수신 설정') {
    await screen.findByText('로그인이 필요해요')
    fireEvent.press(screen.getByLabelText('로그인'))
  }
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe(pathname)
  fireEvent.press(screen.getByLabelText('로그인 취소'))
})

test.each([['공고 검색', 'filter', '공고명·기관명'], ['AI 검색', 'ai', '회사 상황이나 궁금한 점']])(
  'All %s enters the existing search mode', async (label, mode, field) => {
    const view = renderRouter(routes, { initialUrl: '/all' })
    await screen.findByLabelText('메뉴 검색')
    fireEvent.press(screen.getByLabelText(label))
    await screen.findByLabelText(field)
    expect(view.getPathname()).toBe('/')
    expect(view.getSearchParams()).toMatchObject({ mode })
  })

test('legacy chat links redirect to AI search without another visible destination', async () => {
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

test('guest search header login cancels over the same filter mode and draft', async () => {
  const view = renderRouter(routes, { initialUrl: '/?mode=filter' })
  await screen.findByText('검색 결과 0건')
  fireEvent.changeText(screen.getByLabelText('공고명·기관명'), '입력 중인 검색 조건')
  fireEvent.press(screen.getByLabelText('로그인'))
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe('/')
  fireEvent.press(screen.getByLabelText('로그인 취소'))
  expect(screen.getByDisplayValue('입력 중인 검색 조건')).toBeTruthy()
  expect(view.getSearchParams()).toMatchObject({ mode: 'filter' })
})

test('invalid review identifiers stop before entering the private review screen', async () => {
  renderRouter(routes, { initialUrl: '/all/reviews/0' })
  await screen.findByText('올바른 검토·실행 주소가 아닙니다.')
})

test('legacy preparation review links enter the independent native review list', async () => {
  const view = renderRouter(routes, { initialUrl: '/all/preparation?kind=reviews' })
  await screen.findByText('로그인하고 시작')
  await waitFor(() => expect(view.getPathname()).toBe('/all/reviews'))
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
})
