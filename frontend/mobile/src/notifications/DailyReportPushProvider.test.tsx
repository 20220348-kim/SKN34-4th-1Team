import { AppState, Linking, Text, type AppStateStatus } from 'react-native'
import { act, render, screen, waitFor } from '@testing-library/react-native'
import { useAuth } from '../auth/session'
import { disablePush, getPushSettings, registerPush } from '../api/dailyReportPush'
import { getExpoPushToken, getPushDeviceId, notificationModule, PushPermissionDeniedError } from './device'
import { DailyReportPushProvider, useDailyReportPush } from './DailyReportPushProvider'
import { DailyReportPushSettings } from './DailyReportPushSettings'

const mockNavigate = jest.fn()
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate, push: mockPush }), useRootNavigationState: () => ({ key: 'root' }) }))
jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/dailyReportPush', () => ({ getPushSettings: jest.fn(), registerPush: jest.fn(), disablePush: jest.fn() }))
jest.mock('./device', () => ({ ...jest.requireActual('./device'), getExpoPushToken: jest.fn(), getPushDeviceId: jest.fn(), notificationModule: jest.fn(), supportsPushNotifications: () => true }))
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
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  signedIn(); notification = undefined; mockNavigate.mockClear(); mockPush.mockClear()
  jest.mocked(getPushDeviceId).mockResolvedValue('a4a15267-866c-4df0-bb91-55d7c14d7a72')
  jest.mocked(getPushSettings).mockReset().mockResolvedValue(base)
  jest.mocked(registerPush).mockReset().mockResolvedValue(undefined)
  jest.mocked(disablePush).mockReset().mockResolvedValue(undefined)
  jest.mocked(getExpoPushToken).mockReset().mockResolvedValue('ExpoPushToken[test]')
  jest.mocked(notificationModule).mockResolvedValue(native as unknown as Awaited<ReturnType<typeof notificationModule>>)
  native.getLastNotificationResponseAsync.mockResolvedValue(null)
  native.getPermissionsAsync.mockReset().mockResolvedValue({ granted: true, status: 'granted' })
})

test('does not prompt for permission until enabling and keeps permission failure visible', async () => {
  render(app())
  await waitFor(() => expect(push.settings).toEqual(base))
  expect(getExpoPushToken).not.toHaveBeenCalled()
  jest.mocked(getExpoPushToken).mockRejectedValueOnce(new PushPermissionDeniedError())
  await act(async () => push.toggle())
  expect(push.error).toBe('기기 설정에서 GovBiz 알림을 허용해 주세요.')
  expect(push.permissionDenied).toBe(true)
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
  native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' })
  render(app())
  await waitFor(() => expect(disablePush).toHaveBeenCalled())
  await waitFor(() => expect(push.settings?.enabled).toBe(false))
  expect(getExpoPushToken).not.toHaveBeenCalled()
})

test('denied permission is exposed even for a disabled subscription and settings does not enable it', async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' })
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
  try {
    render(app())
    await waitFor(() => expect(push.permissionDenied).toBe(true))
    await act(async () => push.openSystemSettings())
    expect(open).toHaveBeenCalledTimes(1)
    expect(registerPush).not.toHaveBeenCalled()
    expect(push.settings?.enabled).toBe(false)
    expect(getExpoPushToken).not.toHaveBeenCalled()
  } finally { open.mockRestore() }
})

test('undetermined permission leaves the first enable action available without prompting on entry', async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'undetermined' })
  render(<DailyReportPushProvider><Probe /><DailyReportPushSettings hasCompany /></DailyReportPushProvider>)
  await waitFor(() => expect(push.busy).toBe(false))
  expect(push.permissionDenied).toBe(false)
  expect(getExpoPushToken).not.toHaveBeenCalled()
  expect(screen.getByLabelText('이 기기 앱 알림 켜기').props.disabled).toBe(false)
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  await act(async () => push.toggle())
  expect(getExpoPushToken).toHaveBeenCalledWith(true)
  expect(registerPush).toHaveBeenCalledTimes(1)
})

test('system permission is read independently of server delivery availability', async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' })
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, available: false })
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  expect(push.permissionDenied).toBe(true)
  expect(registerPush).not.toHaveBeenCalled()
  expect(disablePush).not.toHaveBeenCalled()
})

test('returning from system settings rechecks permission without silently enabling delivery', async () => {
  let change!: (value: AppStateStatus) => void
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    change = callback; return { remove: jest.fn() }
  })
  try {
    native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' })
    render(app())
    await waitFor(() => expect(push.permissionDenied).toBe(true))
    native.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' })
    await act(async () => change('active'))
    await waitFor(() => expect(push.permissionDenied).toBe(false))
    expect(push.settings?.enabled).toBe(false)
    expect(registerPush).not.toHaveBeenCalled()
    expect(getExpoPushToken).not.toHaveBeenCalled()
  } finally { listener.mockRestore() }
})

test('rapid enable actions register a device once while preserving the confirmed server state', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  let finish!: (value: string) => void
  jest.mocked(getExpoPushToken).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = push.toggle(); second = push.toggle() })
  await waitFor(() => expect(getExpoPushToken).toHaveBeenCalledTimes(1))
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  await act(async () => { finish('ExpoPushToken[new]'); await Promise.all([first, second]) })
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(push.settings?.enabled).toBe(true)
})

test('a late permission read cannot mark the next account as denied', async () => {
  let finish!: (value: { granted: boolean; status: string }) => void
  native.getPermissionsAsync.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = render(app())
  await waitFor(() => expect(native.getPermissionsAsync).toHaveBeenCalledTimes(1))
  signedIn('second'); view.rerender(app())
  await waitFor(() => expect(native.getPermissionsAsync).toHaveBeenCalledTimes(2))
  await act(async () => finish({ granted: false, status: 'denied' }))
  expect(push.permissionDenied).toBe(false)
  expect(registerPush).not.toHaveBeenCalled()
})

test('a stale toggle callback cannot abort or alter the next account settings', async () => {
  const view = render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  const previousToggle = push.toggle
  signedIn('second'); view.rerender(app())
  await waitFor(() => expect(push.busy).toBe(false))
  await act(async () => previousToggle())
  expect(push.busy).toBe(false)
  expect(getExpoPushToken).not.toHaveBeenCalled()
  expect(registerPush).not.toHaveBeenCalled()
})

test('a settings opening failure is explicit and cannot overwrite another account state', async () => {
  const open = jest.spyOn(Linking, 'openSettings').mockRejectedValueOnce(new Error('unavailable'))
  try {
    const view = render(app())
    await waitFor(() => expect(push.busy).toBe(false))
    await act(async () => push.openSystemSettings())
    expect(push.error).toBe('기기 설정을 열지 못했어요. 직접 기기 설정에서 GovBiz 알림을 확인해 주세요.')
    let fail!: () => void
    open.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = () => reject(new Error('late')) }))
    let pending!: Promise<void>
    act(() => { pending = push.openSystemSettings() })
    signedIn('second'); view.rerender(app())
    await waitFor(() => expect(push.busy).toBe(false))
    await act(async () => { fail(); await pending })
    expect(push.error).toBeNull()
  } finally { open.mockRestore() }
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

test('deadline reminder opens only the validated public program detail and never a URL', async () => {
  render(app())
  await waitFor(() => expect(notification).toBeDefined())
  await act(async () => notification?.({ notification: { request: { content: { data: { url: 'https://attacker.test' } } } } }))
  await act(async () => notification?.({ notification: { request: { content: { data: {
    type: 'deadline-reminder', sourceCode: 'BIZINFO', sourceProgramId: 'https://attacker.test ', dueDate: '2026-10-07',
  } } } } }))
  expect(mockPush).not.toHaveBeenCalled()
  await act(async () => notification?.({ notification: { request: { content: { data: {
    type: 'deadline-reminder', sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', dueDate: '2026-10-07', url: 'https://attacker.test',
  } } } } }))
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: '/program', params: { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1' } }))
  expect(mockNavigate).not.toHaveBeenCalled()
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
