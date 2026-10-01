import { fireEvent, render, screen } from '@testing-library/react-native'
import { useAuth } from '../auth/session'
import { MenuScreen } from './MenuScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
const auth = (account: { email: string; company: { companyName: string } | null } | null) => {
  jest.mocked(useAuth).mockReturnValue({ status: account ? 'signedIn' : 'signedOut',
    session: account ? { accessToken: 'token', account } : null, restoreError: null } as unknown as ReturnType<typeof useAuth>)
}
beforeEach(() => auth(null))

test('menu filtering matches descriptions and whitespace and clears an empty result', () => {
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
