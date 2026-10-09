import { Alert, Text } from 'react-native'
import { createContext, useContext, useState } from 'react'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import TabLayout from '../../app/(tabs)/_layout'
import SearchRoute from '../../app/(tabs)/index'
import ChatRoute from '../../app/(tabs)/chat'
import LegacyCollaborationRoute from '../../app/(tabs)/collab'
import CollaborationRoute from '../../app/(tabs)/all/collab'
import ReportRoute from '../../app/(tabs)/report'
import SavedRoute from '../../app/(tabs)/saved'
import PricingRoute from '../../app/(tabs)/pricing'
import MenuPricingRoute from '../../app/(tabs)/all/pricing'
import LegacyAccountRoute from '../../app/(tabs)/account'
import AccountRoute from '../../app/(tabs)/all/account'
import * as AllLayout from '../../app/(tabs)/all/_layout'
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
import NewPreparationRoute from '../../app/(tabs)/all/preparation/new'
import PreparationEditorRoute from '../../app/(tabs)/all/preparation/[id]'
import PreparationReviewRoute from '../../app/(tabs)/all/preparation/[id]/review'
import PreparationDocumentRoute from '../../app/(tabs)/all/preparation/[id]/documents'
import PreparationOnlineRoute from '../../app/(tabs)/all/preparation/[id]/online'
import RecruitmentCreateRoute from '../../app/partner/new'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { documentPreparation } from '../test/applicationDocumentFixtures'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: () => false }))
jest.mock('../auth/introductionStorage', () => ({ completeIntroduction: jest.fn(), readIntroductionCompleted: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), browseRecruitments: jest.fn(), browseProposals: jest.fn() }))
jest.mock('../notifications/DailyReportPushProvider', () => ({ useDailyReportPush: () => ({ settings: null, busy: false, error: null, permissionDenied: false, openSystemSettings: jest.fn() }) }))
jest.mock('../api/applicationPreparation', () => ({ ...jest.requireActual('../api/applicationPreparation'), applicationPreparationUseCase: jest.fn() }))
// 이용량 표시는 ChatScreen·AccountScreen 테스트가 확인합니다. 여기서는 응답을 보내지 않아 네트워크에 닿지 않습니다.
jest.mock('../api/planUsage', () => ({ planUsageUseCase: () => ({ usage: () => new Promise(() => undefined) }) }))

const preparationApi = { get: jest.fn(), replaceInputs: jest.fn() }
const originalApiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL

function ProgramDestination() {
  const params = useLocalSearchParams()
  return <Text>{params.sourceCode}:{params.sourceProgramId}</Text>
}
const routes = {
  _layout: () => <LoginFlowProvider><Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack></LoginFlowProvider>,
  '(tabs)/_layout': TabLayout, '(tabs)/index': SearchRoute, '(tabs)/chat': ChatRoute,
  '(tabs)/collab': LegacyCollaborationRoute, '(tabs)/report': ReportRoute,
  '(tabs)/saved': SavedRoute, '(tabs)/account': LegacyAccountRoute, program: ProgramDestination,
  '(tabs)/pricing': PricingRoute, '(tabs)/all/pricing': MenuPricingRoute,
  '(tabs)/all/_layout': AllLayout, '(tabs)/all/index': MenuRoute, '(tabs)/all/account': AccountRoute,
  '(tabs)/all/collab': CollaborationRoute, '(tabs)/all/company': CompanyRoute,
  '(tabs)/all/settings': SettingsRoute, '(tabs)/all/preparation': PreparationRoute, company: LegacyCompanyRoute,
  '(tabs)/all/preparation/new': NewPreparationRoute, '(tabs)/all/preparation/[id]': PreparationEditorRoute,
  '(tabs)/all/preparation/[id]/review': PreparationReviewRoute, '(tabs)/all/preparation/[id]/documents': PreparationDocumentRoute,
  '(tabs)/all/preparation/[id]/online': PreparationOnlineRoute,
  '(tabs)/all/reviews/index': ReviewListRoute, '(tabs)/all/reviews/new': NewReviewRoute, '(tabs)/all/reviews/[id]': ReviewRoute,
  'partner/new': RecruitmentCreateRoute,
}

beforeEach(() => {
  preparationApi.get.mockReset().mockResolvedValue(documentPreparation)
  preparationApi.replaceInputs.mockReset()
  jest.mocked(applicationPreparationUseCase).mockReturnValue(preparationApi as unknown as ReturnType<typeof applicationPreparationUseCase>)
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

afterEach(() => {
  if (originalApiBaseUrl === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBaseUrl
  jest.restoreAllMocks()
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

const tabLabels = () => screen.getAllByLabelText(/^(검색|협업|요금제|관심함|리포트|메뉴)$/)
  .filter(tab => typeof tab.props.accessibilityState?.selected === 'boolean').map(tab => tab.props.accessibilityLabel)
const memberAuth = { status: 'signedIn', session: { accessToken: 'owner', account: { email: 'member@example.com', company: null } },
  restoreError: null, invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>

const allMenuRoutes = {
  ...routes,
  '(tabs)/all/company': () => <Text>기업 정보 화면</Text>,
  '(tabs)/all/settings': () => <Text>알림 설정 화면</Text>,
  '(tabs)/all/preparation': () => <Text>신청 문서 목록</Text>,
  '(tabs)/all/reviews/index': () => <Text>중복 검토 목록</Text>,
  '(tabs)/all/collab': () => <Text>협업 화면</Text>,
}

test.each([
  ['내 계정', '/all/account'],
  ['요금제', '/all/pricing'],
  ['신청 문서', '/all/preparation'], ['중복 검토', '/all/reviews'], ['모집글', '/all/collab'],
  ['파트너 관리', '/all/collab'],
])('pressing All returns from %s to the menu and allows opening another feature', async (label, pathname) => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(allMenuRoutes, { initialUrl: '/all' })
  fireEvent.press(await screen.findByLabelText(label))
  await waitFor(() => expect(view.getPathname()).toBe(pathname))
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  expect(view.getPathname()).toBe('/all')
  expect(router.canDismiss()).toBe(false)
  fireEvent.press(screen.getByLabelText('파트너 관리'))
  await screen.findByText('협업 화면')
  expect(view.getPathname()).toBe('/all/collab')
})

test('pressing All from another tab returns to the menu without changing the search draft', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(allMenuRoutes, { initialUrl: '/?mode=filter' })
  fireEvent.changeText(await screen.findByLabelText('공고명·기관명'), '유지할 검색 조건')
  fireEvent.press(screen.getByLabelText('메뉴'))
  fireEvent.press(await screen.findByLabelText('내 계정'))
  await waitFor(() => expect(view.getPathname()).toBe('/all/account'))
  fireEvent.press(screen.getByLabelText('검색'))
  await screen.findByDisplayValue('유지할 검색 조건')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('검색'))
  await screen.findByDisplayValue('유지할 검색 조건')
  expect(view.getSearchParams()).toMatchObject({ mode: 'filter' })
})

test.each(['/all/account', '/all/company', '/all/settings', '/all/preparation', '/all/reviews', '/all/collab?view=box&box=sent'])(
  'a direct link to %s has a menu to return to', async (initialUrl) => {
    const view = renderRouter(allMenuRoutes, { initialUrl })
    await waitFor(() => expect(router.canGoBack()).toBe(true))
    await act(async () => router.back())
    await screen.findByLabelText('파트너 관리')
    expect(view.getPathname()).toBe('/all')
    expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
  })

test('pressing All from a direct link and pressing it again keeps one menu screen', async () => {
  const view = renderRouter(allMenuRoutes, { initialUrl: '/all/company' })
  await screen.findByText('기업 정보 화면')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await waitFor(() => expect(view.getPathname()).toBe('/all'))
  expect(router.canDismiss()).toBe(false)
})

test('pressing All recovers a stack that was opened without a menu underneath', async () => {
  const view = renderRouter({ ...allMenuRoutes, '(tabs)/all/_layout': {
    default: AllLayout.default, unstable_settings: { anchor: 'company' },
  } }, { initialUrl: '/all/company' })
  await screen.findByText('기업 정보 화면')
  expect(screen.queryByLabelText('파트너 관리')).toBeNull()
  expect(router.canDismiss()).toBe(false)
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  expect(view.getPathname()).toBe('/all')
  expect(router.canDismiss()).toBe(false)
})

test('pressing All from a nested account screen returns to the menu instead of the first feature', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(allMenuRoutes, { initialUrl: '/all' })
  fireEvent.press(await screen.findByLabelText('내 계정'))
  fireEvent.press(await screen.findByLabelText('기업 프로필 등록'))
  await screen.findByText('기업 정보 화면')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  expect(view.getPathname()).toBe('/all')
  expect(router.canDismiss()).toBe(false)
})

test('pressing All saves a pending document answer before removing its editor', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  let finish!: (value: unknown) => void
  preparationApi.replaceInputs.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(allMenuRoutes, { initialUrl: '/all' })
  await act(async () => router.push('/all/preparation/9'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '전체로 돌아가기 전에 저장할 기업')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await waitFor(() => expect(preparationApi.replaceInputs).toHaveBeenCalledTimes(1))
  expect(view.getPathname()).toBe('/all/preparation/9')
  expect(preparationApi.replaceInputs).toHaveBeenCalledWith(9, 'company', expect.objectContaining({
    expectedRevision: 1, facts: expect.arrayContaining([expect.objectContaining({ fieldKey: 'name', value: '전체로 돌아가기 전에 저장할 기업' })]),
  }), expect.any(AbortSignal))
  await act(async () => finish({ ...documentPreparation, inputRevision: 2 }))
  await screen.findByLabelText('파트너 관리')
  expect(view.getPathname()).toBe('/all')
})

test('a failed document save prevents All from discarding the answer or leaving its editor', async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  preparationApi.replaceInputs.mockRejectedValue(new ApplicationPreparationError(503, 'REQUEST_FAILED'))
  const view = renderRouter(allMenuRoutes, { initialUrl: '/all' })
  await act(async () => router.push('/all/preparation/9'))
  await screen.findByDisplayValue('테스트 기업')
  fireEvent.changeText(screen.getByLabelText('내 답변'), '저장 실패에도 유지할 기업')
  fireEvent.press(screen.getByLabelText('메뉴'))
  await waitFor(() => expect(alert).toHaveBeenCalledWith('답변을 먼저 저장해 주세요', expect.any(String)))
  expect(view.getPathname()).toBe('/all/preparation/9')
  expect(screen.getByLabelText('내 답변').props.value).toBe('저장 실패에도 유지할 기업')
  expect(screen.queryByLabelText('파트너 관리')).toBeNull()
})

test.each(['recruitments', 'box'])('the existing collaboration pencil opens the native form from %s and returns to the same view', async (viewMode) => {
  jest.mocked(useAuth).mockReturnValue({ ...memberAuth, session: { ...memberAuth.session!, account: {
    ...memberAuth.session!.account, company: { companyName: '등록 기업', businessNumber: '1234567890', businessStatusCode: '01' },
  } } })
  const view = renderRouter(routes, { initialUrl: `/all/collab?view=${viewMode}&box=sent` })
  await screen.findByLabelText('모집글 작성')
  fireEvent.press(screen.getByLabelText('모집글 작성'))
  await screen.findByLabelText('모집글 제목 *')
  expect(view.getPathname()).toBe('/partner/new')
  fireEvent.press(screen.getByLabelText('취소'))
  await waitFor(() => expect(view.getPathname()).toBe('/all/collab'))
  expect(view.getSearchParams()).toMatchObject({ view: viewMode, box: 'sent' })
})

test('the collaboration pencil requires company registration before opening the native creation form', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(routes, { initialUrl: '/all/collab' })
  fireEvent.press(await screen.findByLabelText('모집글 작성'))
  await waitFor(() => expect(view.getPathname()).toBe('/all/company'))
  expect(screen.queryByLabelText('모집글 제목 *')).toBeNull()
})

test('guests have search, collaboration, pricing and All and browse public recruitment without private calls', async () => {
  const view = renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(tabLabels()).toEqual(['검색', '협업', '요금제', '메뉴'])
  fireEvent.press(screen.getByLabelText('협업'))
  await screen.findByText('모집글 0건')
  expect(view.getPathname()).toBe('/collab')
  expect(browseProposals).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('파트너 관리')
  expect(screen.getByLabelText('신청 문서')).toBeTruthy()
  expect(screen.getByLabelText('관심 공고함')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('내 계정'))
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('로그인 취소'))
  expect(tabLabels()).toEqual(['검색', '협업', '요금제', '메뉴'])
}, 15_000)

test('verified members retain the original four tabs and private All menu', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '메뉴'])
  fireEvent.press(screen.getByLabelText('메뉴'))
  await screen.findByLabelText('신청 문서')
  expect(screen.getByLabelText('관심 공고함')).toBeTruthy()
})

test.each([false, true])('pricing opens without a new request and its free action preserves the search mode and draft (signed in: %s)', async signedIn => {
  if (signedIn) jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(routes, { initialUrl: '/?mode=filter' })
  fireEvent.changeText(await screen.findByLabelText('공고명·기관명'), '유지할 검색 조건')
  const requests = jest.mocked(programClient).mock.calls.length
  if (signedIn) fireEvent.press(screen.getByLabelText('메뉴'))
  fireEvent.press(screen.getByLabelText('요금제'))
  await screen.findByText('9,900원')
  expect(view.getPathname()).toBe(signedIn ? '/all/pricing' : '/pricing')
  expect(screen.getByLabelText(signedIn ? '메뉴' : '요금제').props.accessibilityState.selected).toBe(true)
  expect(screen.queryByText('로그인이 필요해요')).toBeNull()
  expect(programClient).toHaveBeenCalledTimes(requests)
  fireEvent.press(screen.getByRole('tab', { name: '무료' }))
  fireEvent.press(screen.getByRole('button', { name: '무료로 지원사업 찾기' }))
  await screen.findByDisplayValue('유지할 검색 조건')
  expect(view.getPathname()).toBe('/')
  expect(view.getSearchParams()).toMatchObject({ mode: 'filter' })
})

test('guest menu pricing opens the public pricing tab without requesting login', async () => {
  const view = renderRouter(routes, { initialUrl: '/all' })
  await screen.findByText('서비스 안내')
  const entry = screen.getAllByLabelText('요금제').find(item => item.props.accessibilityState?.selected === undefined)!
  expect(entry.props.accessibilityHint).toBe('기능 · 이용 안내')
  fireEvent.press(entry)
  await screen.findByText('9,900원')
  expect(view.getPathname()).toBe('/pricing')
  expect(screen.queryByText('로그인이 필요해요')).toBeNull()
})

test('a signed-in public pricing link continues in the member menu without a plan change action', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const view = renderRouter(routes, { initialUrl: '/pricing' })
  await screen.findByText('9,900원')
  await waitFor(() => expect(view.getPathname()).toBe('/all/pricing'))
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '메뉴'])
  expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
  expect(screen.queryByRole('button', { name: /체험|이용하기/ })).toBeNull()
})

test('signing in from the guest collaboration tab retains its destination inside the member All stack', async () => {
  const view = renderRouter(routes, { initialUrl: '/collab' })
  await screen.findByText('모집글 0건')
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  await act(async () => router.setParams({ view: 'recruitments' }))
  await waitFor(() => expect(view.getPathname()).toBe('/all/collab'))
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '메뉴'])
  expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
})

test('logging out from a hidden member tab returns to public search with four guest tabs', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  const safeRoutes = { ...routes, '(tabs)/saved': () => <Text>회원 관심함 화면</Text> }
  const view = renderRouter(safeRoutes, { initialUrl: '/saved' })
  await screen.findByText('회원 관심함 화면')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
  await act(async () => router.setParams({ check: 'logout' }))
  await waitFor(() => expect(view.getPathname()).toBe('/'))
  expect(tabLabels()).toEqual(['검색', '협업', '요금제', '메뉴'])
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
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '메뉴'])
})

test('logging in through the guest account menu opens the main search instead of the account screen', async () => {
  let verifyLogin!: () => void
  function ReactiveAuthLayout() {
    const [verified, setVerified] = useState(false)
    verifyLogin = () => setVerified(true)
    jest.mocked(useAuth).mockReturnValue(verified ? memberAuth : { status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
    const Layout = routes._layout
    return <Layout />
  }
  const view = renderRouter({ ...routes, _layout: ReactiveAuthLayout }, { initialUrl: '/all' })
  fireEvent.press(await screen.findByLabelText('내 계정'))
  await screen.findByLabelText('이메일')
  await act(async () => verifyLogin())
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(view.getPathname()).toBe('/')
  expect(screen.queryByLabelText('기업 프로필 등록')).toBeNull()
  expect(tabLabels()).toEqual(['검색', '관심함', '리포트', '메뉴'])
})

test('logging in on a directly opened account route returns to the main search', async () => {
  const signedOut = { status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>
  const TestAuthContext = createContext(signedOut)
  jest.mocked(useAuth).mockImplementation(() => useContext(TestAuthContext))
  let verifyLogin!: () => void
  function ReactiveAuthLayout() {
    const [verified, setVerified] = useState(false)
    verifyLogin = () => setVerified(true)
    const Layout = routes._layout
    return <TestAuthContext.Provider value={verified ? memberAuth : signedOut}><Layout /></TestAuthContext.Provider>
  }
  const view = renderRouter({ ...routes, _layout: ReactiveAuthLayout }, { initialUrl: '/all/account' })
  await screen.findByLabelText('이메일')
  await act(async () => verifyLogin())
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  expect(view.getPathname()).toBe('/')
})

test.each([
  ['/account', '/all/account', '이메일'],
  ['/collab?view=box&box=sent', '/collab', '로그인하기'],
  ['/company', '/all/company', '로그인하기'],
])('legacy %s redirects into All', async (initialUrl, pathname, label) => {
  const view = renderRouter(routes, { initialUrl })
  await screen.findByLabelText(label)
  await waitFor(() => expect(view.getPathname()).toBe(pathname))
  expect(screen.getByLabelText(initialUrl.startsWith('/collab') ? '협업' : '메뉴').props.accessibilityState.selected).toBe(true)
  if (initialUrl.startsWith('/collab')) expect(view.getSearchParams()).toMatchObject({ view: 'box', box: 'sent' })
})

test.each([
  ['알림 설정', '/all/settings', '로그인하면 관심 공고 마감 알림과 리포트 수신 설정을 바꿀 수 있어요.'],
  ['신청 문서', '/all/preparation', '로그인하면 작성한 답변과 신청문서를 웹과 앱에서 함께 확인할 수 있어요.'],
  ['중복 검토', '/all/reviews', '로그인하면 본인의 검토와 참여 이력을 관리할 수 있어요. 기업 등록 없이 직접 입력할 수 있습니다.'],
  ['받은 제안', '/all/collab', '제안함은 로그인 후 확인할 수 있어요.'],
  ['보낸 제안', '/all/collab', '제안함은 로그인 후 확인할 수 있어요.'],
  ['내 모집글', '/all/collab', '내 모집글은 로그인 후 확인할 수 있어요.'],
])('All destination %s opens its login gate with All selected', async (label, pathname, notice) => {
  const suffix = label === '받은 제안' ? '?view=box&box=received' : label === '보낸 제안' ? '?view=box&box=sent' : label === '내 모집글' ? '?mine=1' : ''
  const view = renderRouter(routes, { initialUrl: pathname + suffix })
  await screen.findByText(notice)
  expect(view.getPathname()).toBe(pathname)
  expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
  fireEvent.press(screen.getByLabelText(label === '중복 검토' ? '로그인하고 시작' : label === '신청 문서' ? '로그인하고 시작하기' : '로그인하기'))
  if (label !== '알림 설정') {
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
    await screen.findByLabelText('파트너 관리')
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
  fireEvent.press(screen.getByRole('tab', { name: 'AI 대화 검색' }))
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
  expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
})


test('All partner management switches received, sent and owned tabs and a recruitment menu entry restores its public mode and pencil', async () => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  jest.mocked(browseProposals).mockImplementation(async box => ({ box, proposals: [], pendingCount: 0 }))
  const view = renderRouter(routes, { initialUrl: '/all' })
  fireEvent.press(await screen.findByLabelText('파트너 관리'))
  await waitFor(() => expect(view.getPathname()).toBe('/all/collab'))
  expect(view.getSearchParams()).toMatchObject({ management: '1', view: 'box', box: 'received', mine: '0' })
  expect(screen.queryByLabelText('모집글 작성')).toBeNull()
  fireEvent.press(await screen.findByRole('tab', { name: '보낸 제안' }))
  await waitFor(() => expect(view.getSearchParams()).toMatchObject({ management: '1', view: 'box', box: 'sent', mine: '0' }))
  await waitFor(() => expect(browseProposals).toHaveBeenCalledWith('sent', expect.any(String), expect.any(AbortSignal)))
  fireEvent.press(screen.getByRole('tab', { name: '내 모집글' }))
  await waitFor(() => expect(view.getSearchParams()).toMatchObject({ management: '1', view: 'recruitments', mine: '1' }))
  await waitFor(() => expect(browseRecruitments).toHaveBeenLastCalledWith(expect.objectContaining({ mineOnly: true }), expect.any(String), expect.any(AbortSignal)))
  fireEvent.press(screen.getByLabelText('메뉴'))
  fireEvent.press(await screen.findByLabelText('모집글'))
  await waitFor(() => expect(view.getSearchParams()).toMatchObject({ management: '0', view: 'recruitments', mine: '0' }))
  expect(await screen.findByLabelText('모집글 작성')).toBeTruthy()
  await waitFor(() => expect(browseRecruitments).toHaveBeenLastCalledWith(expect.objectContaining({ mineOnly: false }), expect.any(String), expect.any(AbortSignal)))
}, 15000)

test.each([
  { suffix: '', tab: '받은 제안', mine: false },
  { suffix: '&view=recruitments', tab: '받은 제안', mine: false },
  { suffix: '&mine=1', tab: '내 모집글', mine: true },
])('a direct management link $suffix selects $tab without a public recruitment pencil', async entry => {
  jest.mocked(useAuth).mockReturnValue(memberAuth)
  jest.mocked(browseProposals).mockImplementation(async box => ({ box, proposals: [], pendingCount: 0 }))
  renderRouter(routes, { initialUrl: '/all/collab?management=1' + entry.suffix })
  const tab = await screen.findByRole('tab', { name: entry.tab })
  expect(tab.props.accessibilityState.selected).toBe(true)
  expect(screen.queryByLabelText('모집글 작성')).toBeNull()
  await waitFor(() => expect(browseRecruitments).toHaveBeenLastCalledWith(expect.objectContaining({ mineOnly: entry.mine }), expect.any(String), expect.any(AbortSignal)))
})

test('a guest partner management entry stays on All until verified login and retains its management destination', async () => {
  let verifyLogin!: () => void
  function ReactiveAuthLayout() {
    const [verified, setVerified] = useState(false)
    verifyLogin = () => setVerified(true)
    jest.mocked(useAuth).mockReturnValue(verified ? memberAuth : { status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
    const Layout = routes._layout
    return <Layout />
  }
  const view = renderRouter({ ...routes, _layout: ReactiveAuthLayout }, { initialUrl: '/all' })
  fireEvent.press(await screen.findByLabelText('파트너 관리'))
  await screen.findByText('로그인이 필요해요')
  expect(view.getPathname()).toBe('/all')
  expect(browseProposals).not.toHaveBeenCalled()
  fireEvent.press(screen.getByLabelText('계속 둘러보기'))
  expect(view.getPathname()).toBe('/all')
  fireEvent.press(screen.getByLabelText('파트너 관리'))
  await act(async () => verifyLogin())
  await screen.findByRole('tab', { name: '받은 제안' })
  expect(view.getPathname()).toBe('/all/collab')
  expect(view.getSearchParams()).toMatchObject({ management: '1', view: 'box', box: 'received', mine: '0' })
  expect(screen.getByLabelText('메뉴').props.accessibilityState.selected).toBe(true)
})
