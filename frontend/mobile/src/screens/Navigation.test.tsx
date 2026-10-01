import { Text } from 'react-native'
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
import { browseRecruitments } from '../api/partners'

jest.mock('../auth/session', () => ({ useAuth: () => ({ status: 'signedOut', session: null, restoreError: null }) }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: () => false }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), browseRecruitments: jest.fn() }))

function ProgramDestination() {
  const params = useLocalSearchParams()
  return <Text>{params.sourceCode}:{params.sourceProgramId}</Text>
}
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>,
  '(tabs)/_layout': TabLayout, '(tabs)/index': SearchRoute, '(tabs)/chat': ChatRoute,
  '(tabs)/collab': LegacyCollaborationRoute, '(tabs)/report': ReportRoute,
  '(tabs)/saved': SavedRoute, '(tabs)/account': LegacyAccountRoute, program: ProgramDestination,
  '(tabs)/all/_layout': AllLayout, '(tabs)/all/index': MenuRoute, '(tabs)/all/account': AccountRoute,
  '(tabs)/all/collab': CollaborationRoute, '(tabs)/all/company': CompanyRoute,
  '(tabs)/all/settings': SettingsRoute, '(tabs)/all/preparation': PreparationRoute, company: LegacyCompanyRoute,
  '(tabs)/all/reviews/index': ReviewListRoute, '(tabs)/all/reviews/new': NewReviewRoute, '(tabs)/all/reviews/[id]': ReviewRoute,
}

beforeEach(() => {
  jest.mocked(browseRecruitments).mockResolvedValue({ recruitments: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })
  jest.mocked(programClient).mockReturnValue({ browseCatalog: jest.fn().mockResolvedValue({
    programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0, regions: [], categories: [],
    startupStages: [], applicantTypes: [], founderAges: [],
  }) } as unknown as ReturnType<typeof programClient>)
})

test('four tabs retain their order and All opens collaboration and account without adding a tab', async () => {
  const view = renderRouter(routes, { initialUrl: '/' })
  await screen.findByLabelText('회사 상황이나 궁금한 점')
  const tabs = () => screen.getAllByLabelText(/^(검색|관심함|리포트|전체)$/).map((tab) => tab.props.accessibilityLabel)
  expect(tabs()).toEqual(['검색', '관심함', '리포트', '전체'])
  fireEvent.press(screen.getByLabelText('전체'))
  await screen.findByLabelText('메뉴 검색')
  fireEvent.press(screen.getByLabelText('모집글'))
  await screen.findByText('모집글 0건')
  expect(view.getPathname()).toBe('/all/collab')
  expect(tabs()).toEqual(['검색', '관심함', '리포트', '전체'])
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
  await act(async () => router.back())
  await screen.findByLabelText('메뉴 검색')
  fireEvent.press(screen.getByLabelText('내 계정'))
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe('/all/account')
  expect(tabs()).toEqual(['검색', '관심함', '리포트', '전체'])
  fireEvent.press(screen.getByLabelText('리포트'))
  await screen.findByText('로그인하면 기업 조건에 맞춘 리포트를 확인할 수 있어요.')
  fireEvent.press(screen.getByLabelText('관심함'))
  await screen.findByText('전체 → 내 계정에서 로그인하면 웹과 앱에 저장한 관심 공고를 볼 수 있습니다.')
}, 15_000)

test.each([
  ['/account', '/all/account', '이메일'],
  ['/collab?view=box&box=sent', '/all/collab', '로그인하기'],
  ['/company', '/all/company', '로그인하기'],
])('legacy %s redirects into All', async (initialUrl, pathname, label) => {
  const view = renderRouter(routes, { initialUrl })
  await screen.findByLabelText(label)
  await waitFor(() => expect(view.getPathname()).toBe(pathname))
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
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
  const view = renderRouter(routes, { initialUrl: '/all' })
  await screen.findByLabelText('메뉴 검색')
  fireEvent.press(screen.getByLabelText(label))
  await screen.findByText(notice)
  expect(view.getPathname()).toBe(pathname)
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
  fireEvent.press(screen.getByLabelText(label === '중복 검토' ? '로그인하고 시작' : '로그인하기'))
  await screen.findByLabelText('이메일')
  expect(view.getPathname()).toBe('/all/account')
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
