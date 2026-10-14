import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { readOAuthProviders } from '../api/account'
import { supportsNativeOAuth } from './oauth'
import { SocialLoginOptions } from './SocialLoginOptions'

jest.mock('../api/account', () => ({ readOAuthProviders: jest.fn() }))
jest.mock('./oauth', () => ({ supportsNativeOAuth: jest.fn() }))
const previousSetting = process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
beforeEach(() => {
  process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'true'
  jest.mocked(supportsNativeOAuth).mockReturnValue(true)
  jest.mocked(readOAuthProviders).mockReset().mockResolvedValue([])
})
afterEach(() => {
  if (previousSetting === undefined) delete process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN
  else process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = previousSetting
})

test('lookup loading exposes no guessed providers and renders server-confirmed branded actions in the same order', async () => {
  let complete!: (providers: ('google' | 'kakao')[]) => void
  jest.mocked(readOAuthProviders).mockReturnValue(new Promise(resolve => { complete = resolve }))
  const select = jest.fn()
  render(<SocialLoginOptions enabled busy={false} onSelect={select} />)
  expect(screen.getByLabelText('소셜 로그인 방법 확인 중')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  await act(async () => complete(['google', 'kakao']))
  expect(screen.queryByLabelText('소셜 로그인 방법 확인 중')).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.props.accessibilityLabel)).toEqual(['카카오로 계속하기', 'Google로 계속하기'])
  expect(screen.getByLabelText('카카오로 계속하기')).toHaveStyle({ backgroundColor: '#FEE500', minHeight: 56, borderRadius: 12 })
  expect(screen.getByLabelText('Google로 계속하기')).toHaveStyle({ backgroundColor: '#FFFFFF', borderColor: '#747775', borderWidth: 1, minHeight: 56 })
  fireEvent.press(screen.getByLabelText('카카오로 계속하기'))
  fireEvent.press(screen.getByLabelText('Google로 계속하기'))
  expect(select.mock.calls).toEqual([['kakao'], ['google']])
})

test.each(['disabled', 'nativeUnsupported', 'notEnabled'] as const)('%s does not request providers', condition => {
  if (condition === 'nativeUnsupported') jest.mocked(supportsNativeOAuth).mockReturnValue(false)
  if (condition === 'notEnabled') process.env.EXPO_PUBLIC_ENABLE_SOCIAL_LOGIN = 'false'
  render(<SocialLoginOptions enabled={condition !== 'disabled'} busy={false} onSelect={jest.fn()} />)
  expect(readOAuthProviders).not.toHaveBeenCalled()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByLabelText('소셜 로그인 방법 확인 중')).toBeNull()
})

test('failed lookup stays explicit, retries only by request and accepts a newly available provider', async () => {
  jest.mocked(readOAuthProviders).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['google'])
  const select = jest.fn()
  render(<SocialLoginOptions enabled busy={false} onSelect={select} />)
  await screen.findByText('소셜 로그인 방법을 확인하지 못했어요. 이메일 로그인은 이용할 수 있어요.')
  expect(screen.queryByLabelText('Google로 계속하기')).toBeNull()
  expect(select).not.toHaveBeenCalled()
  expect(readOAuthProviders).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('소셜 로그인 방법 다시 확인'))
  await screen.findByLabelText('Google로 계속하기')
  expect(screen.queryByLabelText('카카오로 계속하기')).toBeNull()
  expect(screen.queryByLabelText('소셜 로그인 방법 다시 확인')).toBeNull()
  expect(readOAuthProviders).toHaveBeenCalledTimes(2)
})

test('busy blocks both provider actions and their request is aborted when the view closes', async () => {
  jest.mocked(readOAuthProviders).mockResolvedValue(['google', 'kakao'])
  const select = jest.fn()
  const view = render(<SocialLoginOptions enabled busy onSelect={select} />)
  const button = await screen.findByLabelText('Google로 계속하기')
  expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true })
  fireEvent.press(button)
  fireEvent.press(screen.getByLabelText('카카오로 계속하기'))
  expect(select).not.toHaveBeenCalled()
  const signal = jest.mocked(readOAuthProviders).mock.calls[0]![0]!
  view.unmount()
  expect(signal.aborted).toBe(true)
})

test('closing during provider lookup discards its late completion', async () => {
  let complete!: (providers: ('google' | 'kakao')[]) => void
  jest.mocked(readOAuthProviders).mockReturnValue(new Promise(resolve => { complete = resolve }))
  const view = render(<SocialLoginOptions enabled busy={false} onSelect={jest.fn()} />)
  const signal = jest.mocked(readOAuthProviders).mock.calls[0]![0]!
  view.rerender(<SocialLoginOptions enabled={false} busy={false} onSelect={jest.fn()} />)
  await act(async () => complete(['kakao']))
  expect(signal.aborted).toBe(true)
  expect(screen.queryByLabelText('카카오로 계속하기')).toBeNull()
})
