import { act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { supportsNativeOAuth } from '../auth/oauth'
import { colors } from '../ui'
import { AccountScreen } from './AccountScreen'

// 하루 한도 안내는 다시 채워질 때까지 남은 시간을 적으므로 시계를 서울 저녁 9시(자정 3시간 전)로 고정합니다. 타이머는 실제로 둡니다.
beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-10-08T21:00:00+09:00'),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      'queueMicrotask', 'hrtime', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
  })
})
afterEach(() => { jest.useRealTimers() })

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


const usage = { plan: 'FREE', items: [
  { feature: 'AI_SEARCH', period: 'DAY', limit: 10, used: 3, resetsAt: '2026-10-09T00:00:00+09:00' },
  // 진행 중인 요청 때문에 한도를 넘겨 세어져도 막대와 숫자는 한도에서 멈춥니다.
  { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: 10, used: 11, resetsAt: '2026-10-09T00:00:00+09:00' },
  { feature: 'APPLICATION_DRAFT', period: 'MONTH', limit: 3, used: 4, resetsAt: '2026-11-01T00:00:00+09:00' },
  { feature: 'COMBINATION_REVIEW', period: 'MONTH', limit: 3, used: 0, resetsAt: '2026-11-01T00:00:00+09:00' },
] }
function signIn() {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@example.com', company: null } },
    restoreError: null, signUp, signIn: jest.fn(), signOut: jest.fn(), refreshSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
}

test('a signed-in account shows its plan and every usage limit as progress without a purchase path', async () => {
  signIn()
  jest.mocked(apiRequest).mockResolvedValue(usage)
  const view = render(<AccountScreen onCompany={jest.fn()} onSettings={jest.fn()} />)
  await view.findByText('요금제와 이용량')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/plan-usage', expect.objectContaining({ accessToken: 'owner' }))
  expect(view.getByText('현재 요금제')).toBeTruthy()
  expect(view.getByText('무료')).toBeTruthy()
  // 남은 양을 줄 오른쪽에, 한도 중 쓴 양을 막대 아래에 적습니다.
  for (const [label, count, used] of [['AI 대화 검색', '오늘 7회 남음', '10회 중 3회 썼어요'], ['공고 원문 질문', '오늘 0회 남음', '10회 중 10회 썼어요'],
    ['신청 문서 초안', '이번 달 0건 남음', '3건 중 3건 썼어요'], ['중복 지원·수혜 검토', '이번 달 3회 남음', '3회 중 0회 썼어요']]) {
    expect(view.getByText(label)).toBeTruthy()
    expect(view.getByText(count)).toBeTruthy()
    expect(view.getByText(used)).toBeTruthy()
  }
  expect(view.getAllByRole('progressbar')).toHaveLength(4)
  expect(view.getByRole('progressbar', { name: 'AI 대화 검색 이용량' }).props.accessibilityValue).toEqual({ min: 0, max: 10, now: 3, text: '10회 중 3회 썼어요' })
  expect(view.getByRole('progressbar', { name: '공고 원문 질문 이용량' }).props.accessibilityValue).toEqual({ min: 0, max: 10, now: 10, text: '10회 중 10회 썼어요' })
  expect(view.getByRole('progressbar', { name: '신청 문서 초안 이용량' }).props.accessibilityValue).toEqual({ min: 0, max: 3, now: 3, text: '3건 중 3건 썼어요' })
  // 같은 때 다시 채워지는 기능끼리(오늘 · 이번 달) 묶어 다시 채워지는 때를 한 번만 적습니다.
  expect(view.getByText('오늘')).toBeTruthy()
  expect(view.getByText('이번 달')).toBeTruthy()
  expect(view.getAllByText('약 3시간 뒤에 다시 채워져요.')).toHaveLength(1)
  expect(view.getAllByText('11월 1일에 다시 채워져요.')).toHaveLength(1)
  expect(StyleSheet.flatten(view.getByText('오늘 0회 남음').props.style).color).toBe(colors.warning)
  expect(StyleSheet.flatten(view.getByText('오늘 7회 남음').props.style).color).not.toBe(colors.warning)
  expect(view.getByText('결제는 아직 받지 않아요.')).toBeTruthy()
  // 앱에서는 이용 현황만 보여 주고 결제·요금제 변경으로 이어지는 안내나 링크를 두지 않습니다.
  expect(view.queryByText(/업그레이드|요금제 보기|요금제 변경|가격|구매|결제하기/)).toBeNull()
  expect(view.queryAllByRole('link')).toHaveLength(0)
  // 이름 붙은 버튼은 그대로이고, 세는 기준은 글자 버튼으로 펼쳐 봅니다.
  expect(view.getAllByRole('button').map(button => button.props.accessibilityLabel).filter(Boolean)).toEqual(['기업 프로필 등록', '알림 설정', '비밀번호 변경', '로그아웃', '계정 삭제', '개인정보 처리방침', '이용약관', '도움말·문의'])
  expect(view.queryByText(/조건을 정리하는 대화와 필터 검색은 세지 않고/)).toBeNull()
  fireEvent.press(view.getByText('이용량을 세는 기준 보기 ▾'))
  expect(view.getByText(/조건을 정리하는 대화와 필터 검색은 세지 않고/)).toBeTruthy()
  expect(view.getByText('신청 문서와 중복 검토는 지워도 그 달에 쓴 횟수가 돌아오지 않아요.')).toBeTruthy()
})

test('a plan without a limit yet shows its usage as unlimited without progress bars', async () => {
  signIn()
  jest.mocked(apiRequest).mockResolvedValue({ plan: 'PREMIUM', items: [
    { feature: 'AI_SEARCH', period: 'DAY', limit: null, used: 42, resetsAt: '2026-10-09T00:00:00+09:00' },
    { feature: 'EVIDENCE_QUESTION', period: 'DAY', limit: null, used: 0, resetsAt: '2026-10-09T00:00:00+09:00' },
  ] })
  const view = render(<AccountScreen onCompany={jest.fn()} onSettings={jest.fn()} />)
  await view.findByText('프리미엄')
  expect(view.getByText('오늘 42회 · 제한 없음')).toBeTruthy()
  expect(view.getByText('오늘 0회 · 제한 없음')).toBeTruthy()
  expect(view.queryByRole('progressbar')).toBeNull()
})

test('account usage that cannot be read offers a retry instead of a guessed count', async () => {
  signIn()
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(usage)
  const view = render(<AccountScreen onCompany={jest.fn()} />)
  await view.findByText('이용량을 불러오지 못했어요.')
  expect(view.queryByRole('progressbar')).toBeNull()
  await act(async () => { fireEvent.press(view.getByLabelText('이용량 다시 불러오기')) })
  await view.findByText('결제는 아직 받지 않아요.')
  expect(view.queryByText('이용량을 불러오지 못했어요.')).toBeNull()
  expect(apiRequest).toHaveBeenCalledTimes(2)
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
  jest.mocked(apiRequest).mockResolvedValue({ plan: 'FREE', items: [] })
  const view = render(<AccountScreen onCompany={jest.fn()} />)
  await view.findByText('무료')
  fireEvent.press(view.getByLabelText('도움말·문의'))
  expect(view.getByText(/실제 문의처는 아직 정해지지 않았어요/)).toBeTruthy()
  expect(view.queryByLabelText('문의처 열기')).toBeNull()
  expect(jest.mocked(useAuth)().session?.accessToken).toBe('owner')
})
