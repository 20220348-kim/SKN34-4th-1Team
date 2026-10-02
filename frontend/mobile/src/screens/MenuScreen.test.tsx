import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { DevSettings } from 'react-native'
import { useAuth } from '../auth/session'
import { MenuScreen } from './MenuScreen'
import { clearIntroductionCompleted } from '../auth/introductionStorage'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/introductionStorage', () => ({ clearIntroductionCompleted: jest.fn() }))
jest.mock('react-native/Libraries/Utilities/DevSettings', () => ({ __esModule: true, default: { reload: jest.fn() } }))
const auth = (account: { email: string; company: { companyName: string } | null } | null) => {
  jest.mocked(useAuth).mockReturnValue({ status: account ? 'signedIn' : 'signedOut',
    session: account ? { accessToken: 'token', account } : null, restoreError: null } as unknown as ReturnType<typeof useAuth>)
}
beforeEach(() => { auth(null); jest.mocked(clearIntroductionCompleted).mockReset().mockResolvedValue(undefined) })
afterEach(() => jest.restoreAllMocks())

test('menu filtering matches descriptions and whitespace and clears an empty result', () => {
  auth({ email: 'member@example.test', company: null })
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  fireEvent.changeText(screen.getByLabelText('메뉴 검색'), '정기 이메일')
  expect(screen.getByLabelText('리포트 수신 설정')).toBeTruthy()
  expect(screen.queryByLabelText('모집글')).toBeNull()
  fireEvent.press(screen.getByLabelText('리포트 수신 설정'))
  expect(open).toHaveBeenCalledWith('settings')
  fireEvent.changeText(screen.getByLabelText('메뉴 검색'), '없는메뉴')
  expect(screen.getByText('검색한 메뉴가 없어요.')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('메뉴 검색 지우기'))
  expect(screen.getByLabelText('모집글')).toBeTruthy()
  expect(screen.queryByText('검색한 메뉴가 없어요.')).toBeNull()
})

test('profile uses the session company or real email and removes them on logout', () => {
  auth({ email: 'member@example.test', company: null })
  const view = render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByText('member@example.test')).toBeTruthy()
  expect(screen.getByLabelText('기업 정보 등록')).toBeTruthy()
  auth({ email: 'business@example.test', company: { companyName: '실제 기업' } })
  view.rerender(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByText('실제 기업')).toBeTruthy()
  expect(screen.getByLabelText('기업 정보')).toBeTruthy()
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

test('development replay clears introduction before reloading without opening another account route', async () => {
  const reload = jest.spyOn(DevSettings, 'reload').mockImplementation(() => undefined)
  const open = jest.fn()
  render(<MenuScreen onOpen={open} />)
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(clearIntroductionCompleted).toHaveBeenCalledTimes(1)
  expect(open).not.toHaveBeenCalled()
})

test('failed introduction reset remains visible and does not reload the app', async () => {
  const reload = jest.spyOn(DevSettings, 'reload').mockImplementation(() => undefined)
  jest.mocked(clearIntroductionCompleted).mockRejectedValueOnce(new Error('storage failure'))
  render(<MenuScreen onOpen={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('기능 소개 다시 보기'))
  await screen.findByText('기능 소개를 다시 열지 못했습니다. 다시 시도해 주세요.')
  expect(reload).not.toHaveBeenCalled()
})

test('the introduction reset is unavailable for signed-in accounts', () => {
  auth({ email: 'member@example.test', company: null })
  render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.queryByLabelText('기능 소개 다시 보기')).toBeNull()
})

test('guest All retains all feature destinations and labels private ones as requiring login', () => {
  render(<MenuScreen onOpen={jest.fn()} />)
  expect(screen.getByLabelText('내 계정')).toBeTruthy()
  expect(screen.getByLabelText('공고 검색')).toBeTruthy()
  expect(screen.getByLabelText('AI 검색')).toBeTruthy()
  expect(screen.getByLabelText('모집글')).toBeTruthy()
  expect(screen.getAllByText('로그인 후 이용').length).toBeGreaterThan(0)
  for (const name of ['기업 정보 등록', '관심 공고함', '맞춤 리포트', '신청 문서', '중복 검토', '받은 제안', '내 모집글']) {
    expect(screen.getByLabelText(name)).toBeTruthy()
  }
})
