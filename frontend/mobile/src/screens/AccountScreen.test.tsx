import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
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

function signIn() {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@example.com', company: null } },
    restoreError: null, signUp, signIn: jest.fn(), signOut: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
}

test('a signed-in account shows its current plan in one line without a purchase path', async () => {
  signIn()
  jest.mocked(apiRequest).mockResolvedValue({ plan: 'FREE' })
  const view = render(<AccountScreen onCompany={jest.fn()} onSettings={jest.fn()} />)
  await view.findByText('무료')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/plan-usage', expect.objectContaining({ accessToken: 'owner' }))
  expect(view.getByText('현재 요금제')).toBeTruthy()
  // 앱에서는 현재 요금제만 보여 주고 결제·요금제 변경으로 이어지는 안내나 링크를 두지 않습니다.
  expect(view.queryByText(/업그레이드|요금제 보기|요금제 변경|가격|구매|결제/)).toBeNull()
  expect(view.queryAllByRole('link')).toHaveLength(0)
  expect(view.getAllByRole('button').map(button => button.props.accessibilityLabel)).toEqual(['기업 프로필 등록', '알림 설정', '로그아웃'])
})

test('a plan that cannot be read is left out instead of guessed', async () => {
  signIn()
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('offline'))
  const view = render(<AccountScreen onCompany={jest.fn()} />)
  await act(async () => {})
  expect(apiRequest).toHaveBeenCalledTimes(1)
  expect(view.queryByText('현재 요금제')).toBeNull()
  expect(view.getByText('owner@example.com')).toBeTruthy()
})


test('signup rejects a password with Korean characters before sending it', async () => {
  const view = await verifyEmail()
  const password = '비밀번호1234'
  fireEvent.changeText(view.getByLabelText('비밀번호'), password)
  fireEvent.changeText(view.getByLabelText('비밀번호 확인'), password)
  fireEvent.press(view.getByText('회원가입'))
  await waitFor(() => expect(view.getByText('비밀번호는 영문·숫자·특수문자만 쓸 수 있습니다.')).toBeTruthy())
  expect(signUp).not.toHaveBeenCalled()
})
