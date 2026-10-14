import { Modal, Text } from 'react-native'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { LoginFlowProvider, useLoginFlow } from './loginFlow'
import { useAuth } from './session'
import { Button } from '../ui'
import { apiRequest } from '../api/client'
import { supportsNativeOAuth } from './oauth'

jest.mock('./session', () => ({ useAuth: jest.fn() }))
jest.mock('./oauth', () => ({ supportsNativeOAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const authenticated = jest.fn()
const cancelled = jest.fn()
const signIn = jest.fn()
const social = jest.fn()
const previousSocialSetting = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
function Origin() {
  const login = useLoginFlow()
  return <><Text>보던 공고</Text><Button label="보던 공고 저장" onPress={() => login({ onAuthenticated: authenticated, onCancel: cancelled })} />
    <Button label="로그인 방법 선택" onPress={() => login({ methods: true, onAuthenticated: authenticated, onCancel: cancelled })} /></>
}
const mount = () => render(<LoginFlowProvider><Origin /></LoginFlowProvider>)
beforeEach(() => {
  authenticated.mockReset(); cancelled.mockReset(); signIn.mockReset().mockResolvedValue(undefined)
  social.mockReset().mockResolvedValue(undefined)
  delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  jest.mocked(supportsNativeOAuth).mockReturnValue(false)
  jest.mocked(apiRequest).mockReset()
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, signIn, signInWithOAuth: social } as unknown as ReturnType<typeof useAuth>)
})
afterEach(() => {
  if (previousSocialSetting === undefined) delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  else process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = previousSocialSetting
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

test('R05 without enabled native providers opens the implemented email form', async () => {
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  expect(screen.queryByLabelText('카카오로 계속하기')).toBeNull()
  expect(screen.queryByLabelText('Google로 계속하기')).toBeNull()
  expect(screen.queryByLabelText('이메일')).toBeNull()
  expect(signIn).not.toHaveBeenCalled()
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

function enableSocial() {
  process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'true'
  jest.mocked(supportsNativeOAuth).mockReturnValue(true)
  jest.mocked(apiRequest).mockResolvedValue({ providers: [{ provider: 'kakao' }, { provider: 'google' }] })
}

test.each(['kakao', 'google'] as const)('R05 executes the real %s login and resumes its origin only once after the verified session', async provider => {
  enableSocial()
  const view = mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  expect(screen.getByLabelText('소셜 로그인 방법 확인 중')).toBeTruthy()
  fireEvent.press(await screen.findByLabelText(provider === 'kakao' ? '카카오로 계속하기' : 'Google로 계속하기'))
  await waitFor(() => expect(social).toHaveBeenCalledWith(provider))
  expect(authenticated).not.toHaveBeenCalled()
  expect(cancelled).not.toHaveBeenCalled()
  expect(signIn).not.toHaveBeenCalled()
  const session = { accessToken: 'verified-social', account: { email: 'social@example.com' } }
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session, signInWithOAuth: social } as unknown as ReturnType<typeof useAuth>)
  view.rerender(<LoginFlowProvider><Origin /></LoginFlowProvider>)
  await waitFor(() => expect(authenticated).toHaveBeenCalledWith(session))
  view.rerender(<LoginFlowProvider><Origin /></LoginFlowProvider>)
  expect(authenticated).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('로그인 방법')).toBeNull()
  expect(screen.getByText('보던 공고')).toBeTruthy()
})

test('R05 provider lookup failure leaves email usable and retry exposes only the available provider', async () => {
  enableSocial()
  jest.mocked(apiRequest).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ providers: [{ provider: 'google' }] })
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  await screen.findByText('소셜 로그인 방법을 확인하지 못했어요. 이메일 로그인은 이용할 수 있어요.')
  expect(screen.getByLabelText('이메일로 로그인').props.accessibilityState.disabled).toBe(false)
  fireEvent.press(screen.getByLabelText('소셜 로그인 방법 다시 확인'))
  await screen.findByLabelText('Google로 계속하기')
  expect(screen.queryByLabelText('카카오로 계속하기')).toBeNull()
  fireEvent.press(screen.getByLabelText('로그인 방법 닫기'))
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(social).not.toHaveBeenCalled()
  expect(authenticated).not.toHaveBeenCalled()
})

test('R05 locks duplicate authentication, form transitions and every close path while OAuth is running', async () => {
  enableSocial()
  let finish!: () => void
  social.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  await screen.findByLabelText('카카오로 계속하기')
  fireEvent.press(screen.getByLabelText('카카오로 계속하기'))
  for (const label of ['카카오로 계속하기', 'Google로 계속하기', '이메일로 로그인', '회원가입하러가기', '로그인 방법 닫기']) {
    expect(screen.getByLabelText(label).props.accessibilityState.disabled).toBe(true)
    fireEvent.press(screen.getByLabelText(label))
  }
  fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose')
  expect(social).toHaveBeenCalledTimes(1)
  expect(screen.queryByLabelText('이메일')).toBeNull()
  expect(cancelled).not.toHaveBeenCalled()
  expect(authenticated).not.toHaveBeenCalled()
  // Cancelling the browser returns without a session, then the user may close the methods sheet.
  await act(async () => finish())
  expect(screen.getByLabelText('로그인 방법 닫기').props.accessibilityState.disabled).toBe(false)
  fireEvent.press(screen.getByLabelText('로그인 방법 닫기'))
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(authenticated).not.toHaveBeenCalled()
  expect(screen.getByText('보던 공고')).toBeTruthy()
})

test('R05 OAuth error remains visible and a new user attempt can succeed without resuming on failure', async () => {
  enableSocial()
  social.mockRejectedValueOnce(new Error('소셜 로그인 요청이 만료되었습니다.')).mockResolvedValueOnce(undefined)
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  fireEvent.press(await screen.findByLabelText('Google로 계속하기'))
  await screen.findByText('소셜 로그인 요청이 만료되었습니다.')
  expect(authenticated).not.toHaveBeenCalled()
  expect(cancelled).not.toHaveBeenCalled()
  expect(screen.getByLabelText('로그인 방법 닫기').props.accessibilityState.disabled).toBe(false)
  await act(async () => fireEvent.press(screen.getByLabelText('Google로 계속하기')))
  expect(social).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('소셜 로그인 요청이 만료되었습니다.')).toBeNull()
})

test('email form OAuth locks the parent cancel before the next render and keeps the form after browser cancellation', async () => {
  enableSocial()
  let finish!: () => void
  social.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  fireEvent.press(screen.getByLabelText('이메일로 로그인'))
  const google = await screen.findByLabelText('Google로 계속하기')
  act(() => {
    fireEvent.press(google)
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose')
  })
  expect(cancelled).not.toHaveBeenCalled()
  expect(screen.getByLabelText('로그인 취소').props.accessibilityState.disabled).toBe(true)
  await act(async () => finish())
  expect(screen.getByLabelText('이메일')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('로그인 취소'))
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(authenticated).not.toHaveBeenCalled()
  expect(screen.getByText('보던 공고')).toBeTruthy()
})

test.each(['이메일로 로그인', '회원가입하러가기'])('same-batch OAuth, %s and cancel retain the busy methods sheet', async label => {
  enableSocial()
  let finish!: () => void
  social.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  mount()
  fireEvent.press(screen.getByLabelText('로그인 방법 선택'))
  await screen.findByLabelText('Google로 계속하기')
  function queuedPress(buttonLabel: string): () => void {
    let element: ReturnType<typeof screen.getByLabelText> | null = screen.getByLabelText(buttonLabel)
    while (element) {
      if (typeof element.props.onPress === 'function') return element.props.onPress
      element = element.parent
    }
    throw new Error(`No press handler for ${buttonLabel}`)
  }
  const startOAuth = queuedPress('Google로 계속하기')
  const openForm = queuedPress(label)
  const close = screen.UNSAFE_getByType(Modal).props.onRequestClose
  // These callbacks were queued while controls were enabled, before busy has rendered.
  act(() => { startOAuth(); openForm(); close() })
  expect(social).toHaveBeenCalledTimes(1)
  expect(screen.getByText('로그인 방법')).toBeTruthy()
  expect(screen.getByLabelText('로그인 방법 닫기').props.accessibilityState.disabled).toBe(true)
  expect(screen.queryByLabelText('이메일')).toBeNull()
  expect(screen.queryByLabelText('비밀번호 확인')).toBeNull()
  expect(cancelled).not.toHaveBeenCalled()
  expect(authenticated).not.toHaveBeenCalled()
  await act(async () => finish())
  fireEvent.press(screen.getByLabelText('로그인 방법 닫기'))
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(authenticated).not.toHaveBeenCalled()
  expect(screen.getByText('보던 공고')).toBeTruthy()
})
