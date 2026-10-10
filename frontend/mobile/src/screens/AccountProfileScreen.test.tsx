import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { ApiError, apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { AccountScreen } from './AccountScreen'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))
const preview = { hasCompany: true, openRecruitmentCount: 2, receivedPendingProposalCount: 3, sentPendingProposalCount: 1 }
const invalidateSession = jest.fn()
function signedIn(hasPassword = true, token = 'owner') {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: token, account: { email: 'owner@example.test', hasPassword, company: null } },
    restoreError: null, invalidateSession, signOut: jest.fn() } as unknown as ReturnType<typeof useAuth>)
}
beforeEach(() => {
  signedIn(); invalidateSession.mockReset().mockResolvedValue(undefined)
  jest.mocked(apiRequest).mockReset().mockImplementation(async path => path === '/api/v1/plan-usage' ? { plan: 'FREE' }
    : path.endsWith('/deletion-preview') ? preview : undefined)
})

test('email deletion reads the actual preview and needs explicit confirmation plus the current password', async () => {
  render(<AccountScreen onCompany={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('계정 삭제'))
  await screen.findByText('내 모집글 2건 마감 · 받은 대기 제안 3건 만료')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/deletion-preview', expect.objectContaining({ accessToken: 'owner' }))
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  expect(screen.queryByLabelText('삭제 확인용 현재 비밀번호')).toBeNull()
  fireEvent.press(screen.getByLabelText('내용 확인하고 계속'))
  fireEvent.changeText(screen.getByLabelText('삭제 확인용 현재 비밀번호'), 'current-secret')
  fireEvent.press(screen.getByLabelText('계정 삭제 확인'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ method: 'DELETE', accessToken: 'owner', body: { password: 'current-secret' } })))
  await waitFor(() => expect(invalidateSession).toHaveBeenCalledTimes(1))
})

test('a passwordless social account is deleted without showing or sending a password', async () => {
  signedIn(false)
  render(<AccountScreen onCompany={jest.fn()} />)
  expect(screen.queryByLabelText('비밀번호 변경')).toBeNull()
  fireEvent.press(screen.getByLabelText('계정 삭제'))
  await screen.findByText('내 모집글 2건 마감 · 받은 대기 제안 3건 만료')
  fireEvent.press(screen.getByLabelText('내용 확인하고 계속'))
  expect(screen.queryByLabelText('삭제 확인용 현재 비밀번호')).toBeNull()
  fireEvent.press(screen.getByLabelText('계정 삭제 확인'))
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ body: {}, accessToken: 'owner' })))
  await waitFor(() => expect(invalidateSession).toHaveBeenCalledTimes(1))
})

test('a rejected deletion never reports success or clears the authenticated session', async () => {
  jest.mocked(apiRequest).mockImplementation(async (path, options) => {
    if (options?.method === 'DELETE') throw new ApiError(422, 'rejected', 'LAST_ADMIN_DELETION')
    return path === '/api/v1/plan-usage' ? { plan: 'FREE' } : path.endsWith('/deletion-preview') ? preview : undefined
  })
  render(<AccountScreen onCompany={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('계정 삭제'))
  await screen.findByText('내 모집글 2건 마감 · 받은 대기 제안 3건 만료')
  fireEvent.press(screen.getByLabelText('내용 확인하고 계속'))
  fireEvent.changeText(screen.getByLabelText('삭제 확인용 현재 비밀번호'), 'current-secret')
  fireEvent.press(screen.getByLabelText('계정 삭제 확인'))
  await screen.findAllByText('마지막 활성 관리자 계정은 삭제할 수 없어요.')
  expect(invalidateSession).not.toHaveBeenCalled()
})

test('a late deletion response cannot clear the next account session', async () => {
  let finish!: () => void
  jest.mocked(apiRequest).mockImplementation((path, options) => options?.method === 'DELETE'
    ? new Promise(resolve => { finish = () => resolve(undefined) }) : Promise.resolve(path === '/api/v1/plan-usage' ? { plan: 'FREE' } : preview))
  const props = { onCompany: jest.fn() }
  const view = render(<AccountScreen {...props} />)
  fireEvent.press(screen.getByLabelText('계정 삭제'))
  await screen.findByText('내 모집글 2건 마감 · 받은 대기 제안 3건 만료')
  fireEvent.press(screen.getByLabelText('내용 확인하고 계속'))
  fireEvent.changeText(screen.getByLabelText('삭제 확인용 현재 비밀번호'), 'current-secret')
  fireEvent.press(screen.getByLabelText('계정 삭제 확인'))
  signedIn(true, 'next-owner'); view.rerender(<AccountScreen {...props} />)
  await act(async () => finish())
  expect(invalidateSession).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('계정 삭제 확인')).toBeNull()
})

test('password change validates confirmation and keeps this session after the successful response', async () => {
  render(<AccountScreen onCompany={jest.fn()} />)
  fireEvent.press(screen.getByLabelText('비밀번호 변경'))
  fireEvent.changeText(screen.getByLabelText('새 비밀번호'), 'newPassword123')
  fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'different123')
  fireEvent.press(screen.getByLabelText('새 비밀번호 저장'))
  await screen.findAllByText('새 비밀번호 확인이 일치하지 않아요.')
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  fireEvent.changeText(screen.getByLabelText('새 비밀번호 확인'), 'newPassword123')
  fireEvent.press(screen.getByLabelText('새 비밀번호 저장'))
  await screen.findByText('비밀번호를 변경했어요. 다른 기기의 로그인은 종료됐어요.')
  expect(apiRequest).toHaveBeenCalledWith('/api/v1/me/password', expect.objectContaining({ accessToken: 'owner', body: { newPassword: 'newPassword123' } }))
  expect(invalidateSession).not.toHaveBeenCalled()
})
