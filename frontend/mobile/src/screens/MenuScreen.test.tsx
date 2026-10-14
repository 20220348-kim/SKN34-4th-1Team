import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AppState, DevSettings, Modal } from 'react-native'
import { useAuth } from '../auth/session'
import { MenuScreen } from './MenuScreen'
import { clearIntroductionCompleted, completeIntroduction } from '../auth/introductionStorage'
import { serviceContact } from '../content/serviceInformation'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/introductionStorage', () => ({ clearIntroductionCompleted: jest.fn(), completeIntroduction: jest.fn() }))
jest.mock('react-native/Libraries/Utilities/DevSettings', () => ({ __esModule: true, default: { reload: jest.fn() } }))
const auth = (account: { email: string; company: { companyName: string } | null } | null) => {
  jest.mocked(useAuth).mockReturnValue({ status: account ? 'signedIn' : 'signedOut',
    session: account ? { accessToken: 'token', account } : null, restoreError: null } as unknown as ReturnType<typeof useAuth>)
}
beforeEach(() => { auth(null); jest.mocked(clearIntroductionCompleted).mockReset().mockResolvedValue(undefined) })

test('mobile assistant entry is offered only to a signed-in account', () => {
  const open = jest.fn(), view = render(<MenuScreen onOpen={open} />)
  expect(screen.queryByLabelText('GovBiz 도우미')).toBeNull()
  auth({ email: 'owner@example.test', company: null })
  view.rerender(<MenuScreen onOpen={open} />)
  fireEvent.press(screen.getByLabelText('GovBiz 도우미'))
  expect(open).toHaveBeenCalledWith('assistant')
  auth(null); view.rerender(<MenuScreen onOpen={open} />)
  expect(screen.queryByLabelText('GovBiz 도우미')).toBeNull()
})

test.each([false, true])('unconfirmed service information is hidden in the menu with signedIn=%s', signedIn => {
  auth(signedIn ? { email: 'owner@example.test', company: null } : null)
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  for (const label of ['개인정보 처리방침', '이용약관', '도움말·문의', '문의처 열기']) expect(screen.queryByLabelText(label)).toBeNull()
  expect(screen.queryByText('문서 초안 · 운영 문서 확정 전')).toBeNull()
  expect(screen.queryByText(/실제 문의처는 아직 정해지지 않았어요/)).toBeNull()
  expect(open).not.toHaveBeenCalled()
})
afterEach(() => { serviceContact.email = null; serviceContact.url = null; jest.restoreAllMocks() })

test('All removes duplicate entries and combines proposal destinations into partner management', () => {
  auth({ email: 'member@example.test', company: null })
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  for (const name of ['메뉴 검색', '기업 정보 등록', '기업 정보', '알림 설정', '내 정보 열기', '받은 제안', '보낸 제안', '내 모집글']) expect(screen.queryByLabelText(name)).toBeNull()
  fireEvent.press(screen.getByLabelText('파트너 관리'))
  expect(open).toHaveBeenCalledWith('partners')
  fireEvent.press(screen.getByLabelText('파트너 모집'))
  expect(open).toHaveBeenCalledWith('recruitments')
  expect(screen.getAllByLabelText('내 프로필')).toHaveLength(1)
})

test('profile uses the session company or real email and removes them on logout', () => {
  auth({ email: 'member@example.test', company: null })
  const view = render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByText('member@example.test')).toBeTruthy()
  expect(screen.queryByLabelText('기업 정보 등록')).toBeNull()
  auth({ email: 'business@example.test', company: { companyName: '실제 기업' } })
  view.rerender(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByText('실제 기업')).toBeTruthy()
  expect(screen.queryByLabelText('기업 정보')).toBeNull()
  expect(screen.queryByText('member@example.test')).toBeNull()
  auth(null)
  view.rerender(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByText('로그인해 주세요')).toBeTruthy()
  expect(screen.queryByText('실제 기업')).toBeNull()
})

test('an unavailable session is an explicit error with a recovery destination', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'unavailable', session: null, restoreError: '복원 실패' } as unknown as ReturnType<typeof useAuth>)
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  expect(screen.getByText('복원 실패')).toBeTruthy()
  expect(screen.queryByText('로그인해 주세요')).toBeNull()
  fireEvent.press(screen.getByLabelText('로그인 상태 확인'))
  expect(open).toHaveBeenCalledWith('account')
})

test.each([false, true])('replay opens in release and development builds without deleting completion with dev=%s', development => {
  jest.replaceProperty(globalThis as unknown as { __DEV__: boolean }, '__DEV__', development)
  const reload = jest.spyOn(DevSettings, 'reload').mockImplementation(() => undefined)
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  expect(screen.getByText('1 / 4')).toBeTruthy()
  expect(screen.queryByLabelText('회원가입하고 시작하기')).toBeNull()
  expect(screen.queryByLabelText('이미 계정이 있습니다')).toBeNull()
  fireEvent.press(screen.getByLabelText('기능 소개 닫기'))
  expect(screen.getByLabelText('파트너 관리')).toBeTruthy()
  expect(screen.queryByText('1 / 4')).toBeNull()
  expect(clearIntroductionCompleted).not.toHaveBeenCalled()
  expect(completeIntroduction).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

test('replay swipes and closes via Android back then starts from the first slide on reopening', () => {
  const view = render(<MenuScreen onOpen={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  fireEvent(screen.getByTestId('welcome-carousel'), 'layout', { nativeEvent: { layout: { width: 360 } } })
  fireEvent(screen.getByTestId('welcome-carousel'), 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 720 } } })
  expect(screen.getByText('3 / 4')).toBeTruthy()
  act(() => view.UNSAFE_getByType(Modal).props.onRequestClose())
  expect(screen.queryByText('3 / 4')).toBeNull()
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  expect(screen.getByText('1 / 4')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('메뉴로 돌아가기'))
  expect(screen.getByLabelText('파트너 관리')).toBeTruthy()
})

test('replay finishes on the fourth slide and closes without writing completion', () => {
  const previousAppState = AppState.currentState
  AppState.currentState = 'active'
  jest.useFakeTimers()
  render(<MenuScreen onOpen={jest.fn()} />)
  try {
    fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
    for (let step = 0; step < 4; step++) act(() => jest.advanceTimersByTime(5000))
    expect(screen.getByText('4 / 4')).toBeTruthy()
    expect(completeIntroduction).not.toHaveBeenCalled()
    fireEvent.press(screen.getByLabelText('메뉴로 돌아가기'))
    expect(screen.getByLabelText('파트너 관리')).toBeTruthy()
  } finally { AppState.currentState = previousAppState; jest.useRealTimers() }
})

test('a signed-in account can replay and keeps its identity when returning to the menu', () => {
  auth({ email: 'member@example.test', company: null })
  render(<MenuScreen onOpen={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  expect(screen.queryByLabelText('이미 계정이 있습니다')).toBeNull()
  fireEvent.press(screen.getByLabelText('메뉴로 돌아가기'))
  expect(screen.getByText('member@example.test')).toBeTruthy()
  expect(clearIntroductionCompleted).not.toHaveBeenCalled()
})

test('guest All retains all feature destinations and labels private ones as requiring login', () => {
  render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByLabelText('내 프로필')).toBeTruthy()
  expect(screen.getByLabelText('필터 검색')).toBeTruthy()
  expect(screen.getByLabelText('AI 대화 검색')).toBeTruthy()
  expect(screen.getByLabelText('파트너 모집')).toBeTruthy()
  expect(screen.getAllByText('로그인 후 이용').length).toBeGreaterThan(0)
  for (const name of ['관심 공고함', '기업 맞춤 리포트', '신청 문서 작성', '중복 지원·수혜 검토', '파트너 관리']) {
    expect(screen.getByLabelText(name)).toBeTruthy()
  }
})

test.each([
  ['내 프로필', 'account'], ['AI 대화 검색', 'ai'], ['필터 검색', 'filter'],
  ['기업 맞춤 리포트', 'report'], ['신청 문서 작성', 'documents'], ['중복 지원·수혜 검토', 'reviews'],
  ['파트너 모집', 'recruitments'], ['파트너 관리', 'partners'],
])('the web-aligned menu label %s still opens the existing %s destination', (label, destination) => {
  auth({ email: 'member@example.test', company: null })
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  fireEvent.press(screen.getByLabelText(label))
  expect(open).toHaveBeenCalledWith(destination)
})

test('unconfirmed service information stays hidden when session restoration is unavailable', () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'unavailable', session: null, restoreError: '복원 실패' } as unknown as ReturnType<typeof useAuth>)
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  for (const label of ['개인정보 처리방침', '이용약관', '도움말·문의']) expect(screen.queryByLabelText(label)).toBeNull()
  expect(screen.queryByText('문서 초안 · 운영 문서 확정 전')).toBeNull()
  expect(screen.getByText('복원 실패')).toBeTruthy()
  expect(screen.getByLabelText('로그인 상태 확인')).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
})

test('setting a contact alone does not restore the unconfirmed menu entry', () => {
  serviceContact.email = 'help@example.test'
  render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.queryByLabelText('도움말·문의')).toBeNull()
  expect(screen.queryByText('도움말 · 문의처 준비 중')).toBeNull()
})
