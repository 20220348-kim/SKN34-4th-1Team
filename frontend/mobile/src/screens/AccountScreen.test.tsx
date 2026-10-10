import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { supportsNativeOAuth } from '../auth/oauth'
import { AccountScreen } from './AccountScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/oauth', () => ({ supportsNativeOAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const signUp = jest.fn().mockResolvedValue(undefined)
const passToken = 'p'.repeat(43)

beforeEach(() => {
  signUp.mockClear()
  jest.mocked(apiRequest).mockReset()
  jest.mocked(supportsNativeOAuth).mockReturnValue(true)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null, signUp, signIn: jest.fn(), signOut: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
})

test('social login exposes only providers confirmed by the server and invokes the native flow', async () => {
  const previous = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'true'
  try {
    const social = jest.fn().mockResolvedValue(undefined)
    jest.mocked(useAuth).mockReturnValue({ ...jest.mocked(useAuth)(), signInWithOAuth: social })
    jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'kakao', startUrl: '/api/v1/auth/oauth/kakao/authorize' }] })
    const view = render(<AccountScreen onCompany={jest.fn()} />)
    fireEvent.press(await view.findByLabelText('카카오로 계속하기'))
    await waitFor(() => expect(social).toHaveBeenCalledWith('kakao'))
    expect(view.queryByLabelText('Google로 계속하기')).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
    else process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = previous
  }
})

test('provider lookup failure is explicit and leaves email login usable', async () => {
  const previous = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'true'
  try {
    jest.mocked(apiRequest).mockRejectedValue(new Error('offline'))
    const view = render(<AccountScreen onCompany={jest.fn()} />)
    await view.findByText('소셜 로그인 방법을 확인하지 못했어요. 이메일 로그인은 이용할 수 있어요.')
    expect(view.queryByLabelText('카카오로 계속하기')).toBeNull()
    expect(view.getByLabelText('이메일').props.editable).toBe(true)
    expect(view.getByLabelText('로그인').props.accessibilityState.disabled).toBe(false)
    jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'google' }] })
    fireEvent.press(view.getByLabelText('소셜 로그인 방법 다시 확인'))
    await view.findByLabelText('Google로 계속하기')
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
    else process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = previous
  }
})

test('a runtime without native OAuth never fetches or exposes providers', () => {
  const previous = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'true'
  try {
    jest.mocked(supportsNativeOAuth).mockReturnValue(false)
    const view = render(<AccountScreen onCompany={jest.fn()} />)
    expect(apiRequest).not.toHaveBeenCalled()
    expect(view.queryByLabelText('카카오로 계속하기')).toBeNull()
    expect(view.queryByLabelText('Google로 계속하기')).toBeNull()
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
    else process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = previous
  }
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
  expect(view.getAllByRole('button').map(button => button.props.accessibilityLabel)).toEqual(['기업 프로필 등록', '알림 설정', '비밀번호 변경', '로그아웃', '계정 삭제', '개인정보 처리방침', '이용약관', '도움말·문의'])
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

test('signup opens draft policy documents without sending authentication requests or clearing its input', () => {
  const view = render(<AccountScreen onCompany={jest.fn()} initialMode="signup" />)
  fireEvent.changeText(view.getByLabelText('이메일'), 'owner@example.test')
  fireEvent.changeText(view.getByLabelText('비밀번호'), 'password123')
  expect(view.getByText(/이용약관과 개인정보 처리방침은 운영 문서 확정 전의 초안/)).toBeTruthy()
  fireEvent.press(view.getByLabelText('이용약관 읽기'))
  expect(view.getByText('문서 초안 · 운영 문서 확정 전')).toBeTruthy()
  fireEvent.press(view.getAllByLabelText('닫기')[0])
  expect(view.getByLabelText('이메일').props.value).toBe('owner@example.test')
  expect(view.getByLabelText('비밀번호').props.value).toBe('password123')
  fireEvent.press(view.getByLabelText('개인정보 처리방침 읽기'))
  expect(view.getByText(/실제 운영 정책으로 확정된 내용이 아니에요/)).toBeTruthy()
  expect(apiRequest).not.toHaveBeenCalled()
  expect(signUp).not.toHaveBeenCalled()
})

test('a signed-in account can open support while keeping its session', async () => {
  signIn()
  jest.mocked(apiRequest).mockResolvedValue({ plan: 'FREE' })
  const view = render(<AccountScreen onCompany={jest.fn()} />)
  await view.findByText('무료')
  fireEvent.press(view.getByLabelText('도움말·문의'))
  expect(view.getByText(/실제 문의처는 아직 정해지지 않았어요/)).toBeTruthy()
  expect(view.queryByLabelText('문의처 열기')).toBeNull()
  expect(jest.mocked(useAuth)().session?.accessToken).toBe('owner')
})
