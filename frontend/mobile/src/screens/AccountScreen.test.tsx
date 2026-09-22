import { fireEvent, render, waitFor } from '@testing-library/react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { AccountScreen } from './AccountScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: () => true }))
jest.mock('../api/client', () => ({ apiRequest: jest.fn(), ApiError: class extends Error {} }))
const signUp = jest.fn().mockResolvedValue(undefined)
const passToken = 'p'.repeat(43)

beforeEach(() => {
  signUp.mockClear()
  jest.mocked(apiRequest).mockReset()
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null, signUp, signIn: jest.fn(), signOut: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})

async function verifyEmail() {
  jest.mocked(apiRequest).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ passToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  const view = render(<AccountScreen onCompany={jest.fn()} />)
  fireEvent.press(view.getByText('이메일로 회원가입'))
  fireEvent.changeText(view.getByLabelText('이메일'), ' USER@example.com ')
  fireEvent.press(view.getByText('인증번호 받기'))
  await waitFor(() => expect(view.getByLabelText('인증번호')).toBeTruthy())
  fireEvent.changeText(view.getByLabelText('인증번호'), '123456')
  fireEvent.press(view.getByText('인증번호 확인'))
  await waitFor(() => expect(view.getByText('이메일 인증을 완료했습니다.')).toBeTruthy())
  return view
}

test('signup submits the verified email token with the normalized email and matching password', async () => {
  const view = await verifyEmail()
  fireEvent.changeText(view.getByLabelText('비밀번호'), 'password123')
  fireEvent.changeText(view.getByLabelText('비밀번호 확인'), 'password123')
  fireEvent.press(view.getByText('회원가입'))
  await waitFor(() => expect(signUp).toHaveBeenCalledWith({ email: 'user@example.com', password: 'password123', emailPassToken: passToken }))
  expect(apiRequest).toHaveBeenNthCalledWith(2, '/api/v1/auth/signup/email-code/verify', expect.objectContaining({ body: { email: 'user@example.com', code: '123456' } }))
})

test('changing the email discards its verification pass and blocks signup', async () => {
  const view = await verifyEmail()
  fireEvent.changeText(view.getByLabelText('이메일'), 'other@example.com')
  fireEvent.changeText(view.getByLabelText('비밀번호'), 'password123')
  fireEvent.changeText(view.getByLabelText('비밀번호 확인'), 'password123')
  fireEvent.press(view.getByText('회원가입'))
  expect(signUp).not.toHaveBeenCalled()
  expect(view.queryByText('이메일 인증을 완료했습니다.')).toBeNull()
  expect(view.getByText('인증번호 받기')).toBeTruthy()
})


test('signup rejects a multibyte password over the server BCrypt limit before sending it', async () => {
  const view = await verifyEmail()
  const password = '가'.repeat(25)
  fireEvent.changeText(view.getByLabelText('비밀번호'), password)
  fireEvent.changeText(view.getByLabelText('비밀번호 확인'), password)
  fireEvent.press(view.getByText('회원가입'))
  await waitFor(() => expect(view.getByText('비밀번호는 8~72자, UTF-8 72바이트 이하로 입력해 주세요.')).toBeTruthy())
  expect(signUp).not.toHaveBeenCalled()
})
