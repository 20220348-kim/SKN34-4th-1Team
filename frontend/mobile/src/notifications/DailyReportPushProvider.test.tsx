import { Text } from 'react-native'
import { act, render, waitFor } from '@testing-library/react-native'
import { useAuth } from '../auth/session'
import { disablePush, getPushSettings, registerPush } from '../api/dailyReportPush'
import { getExpoPushToken, getPushDeviceId, notificationModule } from './device'
import { DailyReportPushProvider, useDailyReportPush } from './DailyReportPushProvider'

const mockNavigate = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate }), useRootNavigationState: () => ({ key: 'root' }) }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/dailyReportPush', () => ({ getPushSettings: jest.fn(), registerPush: jest.fn(), disablePush: jest.fn() }))
jest.mock('./device', () => ({ getExpoPushToken: jest.fn(), getPushDeviceId: jest.fn(), notificationModule: jest.fn(), supportsPushNotifications: () => true }))
const base = { enabled: false, available: true, schedulerEnabled: true, sendHour: 8 }
let push: ReturnType<typeof useDailyReportPush>
let notification: ((response: unknown) => void) | undefined
const native = {
  setNotificationHandler: jest.fn(), addNotificationResponseReceivedListener: jest.fn((callback) => {
    notification = callback; return { remove: jest.fn() }
  }), addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(), clearLastNotificationResponseAsync: jest.fn(), getPermissionsAsync: jest.fn(),
}
function signedIn(token = 'first') {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: token }, invalidateSession: jest.fn() } as unknown as ReturnType<typeof useAuth>)
}
function Probe() { push = useDailyReportPush(); return <Text>{push.error ?? (push.settings?.enabled ? 'enabled' : 'disabled')}</Text> }
const app = () => <DailyReportPushProvider><Probe /></DailyReportPushProvider>
beforeEach(() => {
  signedIn(); notification = undefined; mockNavigate.mockClear()
  jest.mocked(getPushDeviceId).mockResolvedValue('a4a15267-866c-4df0-bb91-55d7c14d7a72')
  jest.mocked(getPushSettings).mockReset().mockResolvedValue(base)
  jest.mocked(registerPush).mockReset().mockResolvedValue(undefined)
  jest.mocked(disablePush).mockReset().mockResolvedValue(undefined)
  jest.mocked(getExpoPushToken).mockReset().mockResolvedValue('ExpoPushToken[test]')
  jest.mocked(notificationModule).mockResolvedValue(native as unknown as Awaited<ReturnType<typeof notificationModule>>)
  native.getLastNotificationResponseAsync.mockResolvedValue(null)
  native.getPermissionsAsync.mockResolvedValue({ granted: true })
})

test('does not prompt for permission until enabling and keeps permission failure visible', async () => {
  render(app())
  await waitFor(() => expect(push.settings).toEqual(base))
  expect(getExpoPushToken).not.toHaveBeenCalled()
  jest.mocked(getExpoPushToken).mockRejectedValueOnce(new Error('알림을 허용해 주세요.'))
  await act(async () => push.toggle())
  expect(push.error).toBe('알림을 허용해 주세요.')
  expect(registerPush).not.toHaveBeenCalled()
  expect(push.settings?.enabled).toBe(false)
})

test('explicit enable registers the current authenticated device then reads server state', async () => {
  render(app())
  await waitFor(() => expect(push.settings).toEqual(base))
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  await act(async () => push.toggle())
  expect(registerPush).toHaveBeenCalledWith('first', { deviceId: 'a4a15267-866c-4df0-bb91-55d7c14d7a72', token: 'ExpoPushToken[test]' }, expect.any(AbortSignal))
  expect(push.settings?.enabled).toBe(true)
})

test('revoked system permission disables server subscription without asking again', async () => {
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  native.getPermissionsAsync.mockResolvedValue({ granted: false })
  render(app())
  await waitFor(() => expect(disablePush).toHaveBeenCalled())
  await waitFor(() => expect(push.settings?.enabled).toBe(false))
  expect(getExpoPushToken).not.toHaveBeenCalled()
})

test('notification opens only the validated report after authentication', async () => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as unknown as ReturnType<typeof useAuth>)
  const view = render(app())
  await waitFor(() => expect(notification).toBeDefined())
  await act(async () => notification?.({ notification: { request: { content: { data: {
    type: 'daily-report', reportId: '42', reportDate: '2026-10-02', url: 'https://attacker.test',
  } } } } }))
  expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/all/account')
  signedIn(); view.rerender(app())
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/(tabs)/report', params: { reportId: '42' } }))
})

test('late token result after account change is discarded before registration', async () => {
  jest.mocked(getPushSettings).mockResolvedValueOnce({ ...base, enabled: true })
  let resolve!: (token: string) => void
  jest.mocked(getExpoPushToken).mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const view = render(app())
  await waitFor(() => expect(getExpoPushToken).toHaveBeenCalled())
  signedIn('second'); view.rerender(app())
  await act(async () => resolve('ExpoPushToken[old]'))
  await waitFor(() => expect(push.settings).toEqual(base))
  expect(registerPush).not.toHaveBeenCalled()
})
