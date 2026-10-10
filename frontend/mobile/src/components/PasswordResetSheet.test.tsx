import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { ApiError, apiRequest } from '../api/client'
import { PasswordResetSheet } from './PasswordResetSheet'

jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
beforeEach(() => jest.mocked(apiRequest).mockReset())

test('recovery verifies the emailed code before saving the new password and returns to login', async () => {
  const close = jest.fn(), token = 'r'.repeat(43)
  jest.mocked(apiRequest).mockImplementation(async path => path.endsWith('/verify')
    ? { passToken: token, expiresAt: new Date(Date.now() + 60_000).toISOString() } : undefined)
  render(<PasswordResetSheet visible onClose={close} />)
  fireEvent.changeText(screen.getByLabelText('재설정 이메일'), ' OWNER@example.test ')
  fireEvent.press(screen.getByLabelText('인증번호 받기'))
  await screen.findByLabelText('재설정 인증번호')
  fireEvent.changeText(screen.getByLabelText('재설정 인증번호'), '123456')
  fireEvent.press(screen.getByLabelText('인증번호 확인'))
  await screen.findByLabelText('새 비밀번호')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호'), 'newPassword123')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'newPassword123')
  fireEvent.press(screen.getByLabelText('새 비밀번호 저장'))
  await screen.findByText('비밀번호를 변경했어요. 모든 기존 로그인 세션이 종료됐으니 새 비밀번호로 다시 로그인해 주세요.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/password-reset', expect.objectContaining({ body: { email: 'owner@example.test' } }))
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/auth/password-reset/confirm', expect.objectContaining({ body: { token, newPassword: 'newPassword123' } }))
  fireEvent.press(screen.getByLabelText('로그인으로 돌아가기'))
  expect(close).toHaveBeenCalledTimes(1)
})

test('an expired pass blocks the password write and returns to code entry', async () => {
  jest.mocked(apiRequest).mockImplementation(async path => path.endsWith('/verify')
    ? { passToken: 'r'.repeat(43), expiresAt: new Date(Date.now() - 1_000).toISOString() } : undefined)
  render(<PasswordResetSheet visible onClose={jest.fn()} />)
  fireEvent.changeText(screen.getByLabelText('재설정 이메일'), 'owner@example.test')
  fireEvent.press(screen.getByLabelText('인증번호 받기'))
  await screen.findByLabelText('재설정 인증번호')
  fireEvent.changeText(screen.getByLabelText('재설정 인증번호'), '123456')
  fireEvent.press(screen.getByLabelText('인증번호 확인'))
  await screen.findByLabelText('새 비밀번호')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호'), 'newPassword123')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'newPassword123')
  fireEvent.press(screen.getByLabelText('새 비밀번호 저장'))
  await screen.findByText('인증이 만료됐어요. 인증번호를 다시 받아 주세요.')
  expect(screen.getByLabelText('재설정 인증번호')).toBeTruthy()
  expect(jest.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith('/confirm'))).toBe(false)
})

test('an already consumed server pass is rejected without reporting password reset success', async () => {
  jest.mocked(apiRequest).mockImplementation(async path => {
    if (path.endsWith('/verify')) return { passToken: 'r'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    if (path.endsWith('/confirm')) throw new ApiError(422, 'rejected', 'PASSWORD_RESET_TOKEN_INVALID')
    return undefined
  })
  render(<PasswordResetSheet visible onClose={jest.fn()} />)
  fireEvent.changeText(screen.getByLabelText('재설정 이메일'), 'owner@example.test')
  fireEvent.press(screen.getByLabelText('인증번호 받기'))
  await screen.findByLabelText('재설정 인증번호')
  fireEvent.changeText(screen.getByLabelText('재설정 인증번호'), '123456')
  fireEvent.press(screen.getByLabelText('인증번호 확인'))
  await screen.findByLabelText('새 비밀번호')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호'), 'newPassword123')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'newPassword123')
  fireEvent.press(screen.getByLabelText('새 비밀번호 저장'))
  await screen.findByText('인증이 만료됐거나 이미 사용됐어요. 인증번호를 다시 받아 주세요.')
  expect(screen.queryByLabelText('로그인으로 돌아가기')).toBeNull()
})

test('closing the recovery flow aborts its request and ignores a late email response after reopening', async () => {
  let finish!: () => void
  jest.mocked(apiRequest).mockReturnValue(new Promise(resolve => { finish = () => resolve(undefined) }))
  const props = { onClose: jest.fn() }
  const view = render(<PasswordResetSheet visible {...props} />)
  fireEvent.changeText(screen.getByLabelText('재설정 이메일'), 'owner@example.test')
  fireEvent.press(screen.getByLabelText('인증번호 받기'))
  const signal = jest.mocked(apiRequest).mock.calls[0][1]?.signal
  view.rerender(<PasswordResetSheet visible={false} {...props} />)
  view.rerender(<PasswordResetSheet visible {...props} />)
  await act(async () => finish())
  expect(signal?.aborted).toBe(true)
  expect(screen.getByLabelText('재설정 이메일').props.value).toBe('')
  expect(screen.queryByLabelText('재설정 인증번호')).toBeNull()
})

test('a failed email request keeps the address and never advances to verification', async () => {
  jest.mocked(apiRequest).mockRejectedValue(new Error('connection failed'))
  render(<PasswordResetSheet visible onClose={jest.fn()} />)
  fireEvent.changeText(screen.getByLabelText('재설정 이메일'), 'owner@example.test')
  fireEvent.press(screen.getByLabelText('인증번호 받기'))
  await screen.findByText('connection failed')
  expect(screen.queryByLabelText('재설정 인증번호')).toBeNull()
  expect(screen.getByLabelText('재설정 이메일').props.value).toBe('owner@example.test')
  await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1))
})
