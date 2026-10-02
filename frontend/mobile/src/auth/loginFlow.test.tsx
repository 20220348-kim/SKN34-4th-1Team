import { Text } from 'react-native'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { LoginFlowProvider, useLoginFlow } from './loginFlow'
import { useAuth } from './session'
import { Button } from '../ui'

jest.mock('./session', () => ({ useAuth: jest.fn() }))
jest.mock('./oauth', () => ({ supportsNativeOAuth: () => false }))
const authenticated = jest.fn()
const cancelled = jest.fn()
const signIn = jest.fn()
function Origin() {
  const login = useLoginFlow()
  return <><Text>보던 공고</Text><Button label="보던 공고 저장" onPress={() => login({ onAuthenticated: authenticated, onCancel: cancelled })} />
    <Button label="로그인 방법 선택" onPress={() => login({ methods: true, onAuthenticated: authenticated })} /></>
}
const mount = () => render(<LoginFlowProvider><Origin /></LoginFlowProvider>)
beforeEach(() => {
  authenticated.mockReset(); cancelled.mockReset(); signIn.mockReset().mockResolvedValue(undefined)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, signIn } as unknown as ReturnType<typeof useAuth>)
})
test('cancelling the prompt or login retains its origin and never resumes the selected action', async () => {
  mount()
  fireEvent.press(screen.getByLabelText('보던 공고 저장'))
  fireEvent.press(screen.getByLabelText('계속 둘러보기'))
  expect(screen.getByText('보던 공고')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('보던 공고 저장'))
  fireEvent.press(screen.getByLabelText('로그인'))
  fireEvent.press(screen.getByLabelText('로그인 취소'))
  expect(cancelled).toHaveBeenCalledTimes(2)
  expect(authenticated).not.toHaveBeenCalled()
  expect(signIn).not.toHaveBeenCalled()
})
test('successful email authentication closes the modal and resumes only once with the verified session', async () => {
  const view = mount()
  fireEvent.press(screen.getByLabelText('보던 공고 저장'))
  fireEvent.press(screen.getByLabelText('로그인'))
  fireEvent.changeText(screen.getByLabelText('이메일'), 'user@example.com')
  fireEvent.changeText(screen.getByLabelText('비밀번호'), 'password123')
  fireEvent.press(screen.getByLabelText('로그인'))
  await waitFor(() => expect(signIn).toHaveBeenCalledWith('user@example.com', 'password123'))
  const session = { accessToken: 'verified', account: { email: 'user@example.com' } }
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session } as ReturnType<typeof useAuth>)
  view.rerender(<LoginFlowProvider><Origin /></LoginFlowProvider>)
  await waitFor(() => expect(authenticated).toHaveBeenCalledWith(session))
  view.rerender(<LoginFlowProvider><Origin /></LoginFlowProvider>)
  expect(authenticated).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('이메일')).toBeNull()
  expect(screen.getByText('보던 공고')).toBeTruthy()
})

test('R05 always displays three methods and only email opens the implemented login form', async () => {
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  expect(screen.getByLabelText('카카오로 계속하기')).toBeTruthy()
  expect(screen.getByLabelText('Google 계정으로 계속하기')).toBeTruthy()
  expect(screen.queryByLabelText('이메일')).toBeNull()
  fireEvent.press(screen.getByLabelText('카카오로 계속하기'))
  expect(signIn).not.toHaveBeenCalled()
  expect(screen.getByText(/카카오 로그인은 모바일 연결을 준비/)).toBeTruthy()
  fireEvent.press(screen.getByLabelText('이메일로 로그인'))
  expect(screen.getByLabelText('이메일')).toBeTruthy()
  expect(screen.queryByLabelText('카카오로 계속하기')).toBeNull()
})

test('R05 closes via its X control and its signup link opens the existing signup form', () => {
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  expect(screen.queryByRole('button', { name: '닫기' })).toBeNull()
  expect(screen.getByText('처음이신가요?')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('로그인 방법 닫기'))
  expect(screen.queryByText('로그인 방법')).toBeNull()
  expect(screen.getByText('보던 공고')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  fireEvent.press(screen.getByLabelText('회원가입하러가기'))
  expect(screen.getByLabelText('비밀번호 확인')).toBeTruthy()
  expect(signIn).not.toHaveBeenCalled()
})
