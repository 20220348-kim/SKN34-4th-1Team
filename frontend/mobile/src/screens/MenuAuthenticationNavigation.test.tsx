import { act, fireEvent, render, screen } from '@testing-library/react-native'
import MenuRoute from '../../app/(tabs)/all/index'
import { useAuth } from '../auth/session'

const mockRequestLogin = jest.fn(), mockNavigate = jest.fn(), mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate, push: mockPush }) }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => mockRequestLogin }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))

beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null, restoreError: null } as ReturnType<typeof useAuth>)
})

test('the menu login button opens the direct existing form and navigates only after verified authentication', () => {
  render(<MenuRoute />)
  fireEvent.press(screen.getByRole('button', { name: '로그인' }))
  expect(mockRequestLogin).toHaveBeenCalledWith(expect.objectContaining({ direct: true }))
  expect(mockNavigate).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  act(() => mockRequestLogin.mock.calls[0][0].onAuthenticated())
  expect(mockNavigate).toHaveBeenCalledWith('/(tabs)')
})

test('menu logout calls the existing auth operation and leaves navigation on the menu', async () => {
  const signOut = jest.fn().mockResolvedValue(undefined)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'owner@example.test', company: null } },
    restoreError: null, signOut } as unknown as ReturnType<typeof useAuth>)
  render(<MenuRoute />)
  await act(async () => fireEvent.press(screen.getByLabelText('로그아웃')))
  expect(signOut).toHaveBeenCalledTimes(1)
  expect(mockRequestLogin).not.toHaveBeenCalled()
  expect(mockNavigate).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
})
