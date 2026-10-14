import { AppState, Linking, Text, type AppStateStatus } from 'react-native'
import { act, render, screen, waitFor } from '@testing-library/react-native'
import type { DevicePushToken } from 'expo-notifications'
import { useAuth } from '../auth/session'
import { ApiError } from '../api/client'
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
let tokenNotification: ((token: DevicePushToken) => void) | undefined
const deviceToken: DevicePushToken = { type: 'android', data: 'native-token' }
const native = {
  setNotificationHandler: jest.fn(), addNotificationResponseReceivedListener: jest.fn((callback) => {
    notification = callback; return { remove: jest.fn() }
  }), addPushTokenListener: jest.fn((callback) => { tokenNotification = callback; return { remove: jest.fn() } }),
  getLastNotificationResponseAsync: jest.fn(), clearLastNotificationResponseAsync: jest.fn(), getPermissionsAsync: jest.fn(),
}
function signedIn(token = 'first') {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: token }, invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>)
}
function Probe() { push = useDailyReportPush(); return <Text>{push.error ?? (push.settings?.enabled ? 'enabled' : 'disabled')}</Text> }
const app = () => <DailyReportPushProvider><Probe /></DailyReportPushProvider>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() })
  signedIn(); notification = undefined; tokenNotification = undefined; mockNavigate.mockClear(); mockPush.mockClear()
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
  jest.mocked(getPushSettings).mockResolvedValueOnce({ ...base, enabled: true }).mockResolvedValue(base)
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

test('SDK token event during explicit token lookup cannot cancel registration or register twice', async () => {
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(tokenNotification).toBeDefined() })
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  jest.mocked(getExpoPushToken).mockImplementation(async (_permission, suppliedToken) => {
    if (!suppliedToken) tokenNotification?.(deviceToken)
    return 'ExpoPushToken[test]'
  })
  await act(async () => push.toggle())
  await waitFor(() => expect(push.busy).toBe(false))
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(jest.mocked(registerPush).mock.calls[0][2]?.aborted).toBe(false)
  expect(getExpoPushToken).toHaveBeenNthCalledWith(1, true)
  expect(getExpoPushToken).toHaveBeenNthCalledWith(2, false, deviceToken)
  expect(getPushSettings).toHaveBeenCalledTimes(2)
  expect(push.error).toBeNull()
  expect(push.settings?.enabled).toBe(true)
})

test('enabled refresh handles its SDK token event without recursive reads or duplicate registration', async () => {
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  // A native token read emits the same SDK event; supplied native tokens do not perform that read.
  jest.mocked(getExpoPushToken).mockImplementation(async (_permission, suppliedToken) => {
    if (!suppliedToken) tokenNotification?.(deviceToken)
    return 'ExpoPushToken[test]'
  })
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(registerPush).toHaveBeenCalledTimes(1) })
  expect(getExpoPushToken).toHaveBeenCalledTimes(2)
  expect(getExpoPushToken).toHaveBeenLastCalledWith(false, deviceToken)
  expect(getPushSettings).toHaveBeenCalledTimes(1)
  await act(async () => push.refresh())
  await waitFor(() => { expect(getPushSettings).toHaveBeenCalledTimes(2); expect(push.busy).toBe(false) })
  expect(getExpoPushToken).toHaveBeenCalledTimes(3)
  expect(registerPush).toHaveBeenCalledTimes(1)
})

test('refresh requests while registering are coalesced until registration and confirmation finish', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  const token = deferred<string>()
  jest.mocked(getExpoPushToken).mockReturnValueOnce(token.promise)
  let pending!: Promise<void>
  act(() => { pending = push.toggle() })
  await waitFor(() => expect(getExpoPushToken).toHaveBeenCalledTimes(1))
  act(() => { push.refresh(); push.refresh() })
  expect(getPushSettings).toHaveBeenCalledTimes(1)
  expect(push.busy).toBe(true)
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  await act(async () => { token.resolve('ExpoPushToken[test]'); await pending })
  await waitFor(() => { expect(getPushSettings).toHaveBeenCalledTimes(3); expect(push.busy).toBe(false) })
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(jest.mocked(registerPush).mock.calls[0][2]?.aborted).toBe(false)
  expect(push.settings?.enabled).toBe(true)
  expect(push.error).toBeNull()
})

test('native token events cannot silently enable an off device', async () => {
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(tokenNotification).toBeDefined() })
  await act(async () => tokenNotification?.(deviceToken))
  expect(getExpoPushToken).not.toHaveBeenCalled()
  expect(registerPush).not.toHaveBeenCalled()
  expect(getPushSettings).toHaveBeenCalledTimes(1)
  expect(push.settings?.enabled).toBe(false)
})

test('a queued SDK token event after provider disposal cannot start another registration', async () => {
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  const view = render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(tokenNotification).toBeDefined() })
  const queuedEvent = tokenNotification!
  view.unmount()
  jest.mocked(getExpoPushToken).mockResolvedValue('ExpoPushToken[late]')
  await act(async () => queuedEvent(deviceToken))
  expect(getExpoPushToken).toHaveBeenCalledTimes(1)
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(getPushSettings).toHaveBeenCalledTimes(1)
})

test('duplicate events share one synchronization and changed events wait for the current registration', async () => {
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(tokenNotification).toBeDefined() })
  const first = deferred<string>()
  const secondToken: DevicePushToken = { type: 'android', data: 'rotated-native-token' }
  jest.mocked(getExpoPushToken).mockReturnValueOnce(first.promise).mockResolvedValueOnce('ExpoPushToken[rotated]')
  act(() => { tokenNotification?.(deviceToken); tokenNotification?.(deviceToken); tokenNotification?.(secondToken) })
  await waitFor(() => expect(getExpoPushToken).toHaveBeenCalledTimes(2))
  expect(registerPush).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve('ExpoPushToken[new]'))
  await waitFor(() => { expect(registerPush).toHaveBeenCalledTimes(3); expect(push.busy).toBe(false) })
  expect(getExpoPushToken).toHaveBeenNthCalledWith(2, false, deviceToken)
  expect(getExpoPushToken).toHaveBeenNthCalledWith(3, false, secondToken)
  await act(async () => { tokenNotification?.(secondToken); tokenNotification?.(secondToken) })
  expect(getExpoPushToken).toHaveBeenCalledTimes(3)
  expect(registerPush).toHaveBeenCalledTimes(3)
  expect(jest.mocked(registerPush).mock.calls.map(call => call[1].token)).toEqual([
    'ExpoPushToken[test]', 'ExpoPushToken[new]', 'ExpoPushToken[rotated]',
  ])
})

test.each(['signedOut', 'second'] as const)('explicit registration is discarded after session changes to %s', async (next) => {
  const view = render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  const token = deferred<string>()
  jest.mocked(getExpoPushToken).mockReturnValueOnce(token.promise)
  let pending!: Promise<void>
  act(() => { pending = push.toggle() })
  await waitFor(() => expect(getExpoPushToken).toHaveBeenCalledTimes(1))
  if (next === 'signedOut') jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as unknown as ReturnType<typeof useAuth>)
  else signedIn(next)
  view.rerender(app())
  await act(async () => { token.resolve('ExpoPushToken[old]'); await pending })
  await waitFor(() => expect(push.busy).toBe(false))
  expect(registerPush).not.toHaveBeenCalled()
  expect(push.settings).toEqual(next === 'signedOut' ? null : base)
  expect(push.error).toBeNull()
})

test('unmount aborts an in-flight registration and ignores its late failure', async () => {
  const view = render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  const registration = deferred<void>()
  jest.mocked(registerPush).mockReturnValueOnce(registration.promise)
  let pending!: Promise<void>
  act(() => { pending = push.toggle() })
  await waitFor(() => expect(registerPush).toHaveBeenCalledTimes(1))
  const signal = jest.mocked(registerPush).mock.calls[0][2]
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { registration.reject(new ApiError(401, 'expired')); await pending })
  expect(jest.mocked(useAuth)().invalidateSession).not.toHaveBeenCalled()
  expect(getPushSettings).toHaveBeenCalledTimes(1)
})

test('a late unauthorized response from the previous account cannot invalidate the current account', async () => {
  const view = render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  const registration = deferred<void>()
  jest.mocked(registerPush).mockReturnValueOnce(registration.promise)
  let pending!: Promise<void>
  act(() => { pending = push.toggle() })
  await waitFor(() => expect(registerPush).toHaveBeenCalledTimes(1))
  signedIn('second'); view.rerender(app())
  await waitFor(() => expect(push.busy).toBe(false))
  await act(async () => { registration.reject(new ApiError(401, 'expired')); await pending })
  expect(jest.mocked(useAuth)().invalidateSession).not.toHaveBeenCalled()
  expect(push.settings).toEqual(base)
  expect(push.error).toBeNull()
})

test('a failed registration shows the server error and preserves the confirmed off value', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  jest.mocked(registerPush).mockRejectedValueOnce(new ApiError(503, 'unavailable'))
  await act(async () => push.toggle())
  expect(push.error).toBe('앱 알림 발송이 현재 준비되지 않았어요.')
  expect(push.settings?.enabled).toBe(false)
  expect(push.busy).toBe(false)
})

test('a transport failure during registration reports an unknown result without assuming it is enabled', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  jest.mocked(registerPush).mockRejectedValueOnce(new TypeError('network lost'))
  await act(async () => push.toggle())
  expect(push.error).toBe('앱 알림 설정 변경 결과를 확인하지 못했어요. 다시 확인해 주세요.')
  expect(push.settings?.enabled).toBe(false)
  expect(getPushSettings).toHaveBeenCalledTimes(1)
})

test('confirmation failure after successful registration stays visible until a successful refresh', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  jest.mocked(getPushSettings).mockRejectedValueOnce(new TypeError('read lost'))
  await act(async () => push.toggle())
  expect(push.error).toBe('앱 알림 설정을 변경했지만 서버 상태를 확인하지 못했어요. 다시 확인해 주세요.')
  expect(push.settings?.enabled).toBe(false)
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  await act(async () => push.refresh())
  await waitFor(() => { expect(push.settings?.enabled).toBe(true); expect(push.busy).toBe(false) })
  expect(push.error).toBeNull()
  expect(registerPush).toHaveBeenCalledTimes(1)
})

test('a server response that did not apply the requested setting is explicit instead of silently reverting', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  await act(async () => push.toggle())
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(push.settings?.enabled).toBe(false)
  expect(push.error).toBe('앱 알림 설정이 요청한 상태로 확인되지 않았어요. 다시 확인해 주세요.')
})

test('an unauthorized confirmation still invalidates the active session and leaves an explicit error', async () => {
  render(app())
  await waitFor(() => expect(push.busy).toBe(false))
  jest.mocked(getPushSettings).mockRejectedValueOnce(new ApiError(401, 'expired'))
  await act(async () => push.toggle())
  expect(jest.mocked(useAuth)().invalidateSession).toHaveBeenCalledTimes(1)
  expect(push.error).toBe('앱 알림 설정을 변경했지만 서버 상태를 확인하지 못했어요. 다시 확인해 주세요.')
})

test('a token renewal failure remains visible and does not query or change subscription settings', async () => {
  jest.mocked(getPushSettings).mockResolvedValue({ ...base, enabled: true })
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(tokenNotification).toBeDefined() })
  jest.mocked(getExpoPushToken).mockRejectedValueOnce(new Error('앱 알림 토큰을 받지 못했어요.'))
  await act(async () => tokenNotification?.(deviceToken))
  await waitFor(() => expect(push.error).toBe('앱 알림 토큰을 받지 못했어요.'))
  expect(push.settings?.enabled).toBe(true)
  expect(registerPush).toHaveBeenCalledTimes(1)
  expect(getPushSettings).toHaveBeenCalledTimes(1)
})

test('foreground permission revocation disables an enabled device using the confirmed server response', async () => {
  let enabled = true
  jest.mocked(getPushSettings).mockImplementation(async () => ({ ...base, enabled }))
  jest.mocked(disablePush).mockImplementation(async () => { enabled = false })
  let change!: (state: AppStateStatus) => void
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => { change = callback; return { remove: jest.fn() } })
  render(app())
  await waitFor(() => { expect(push.busy).toBe(false); expect(registerPush).toHaveBeenCalledTimes(1) })
  native.getPermissionsAsync.mockResolvedValue({ granted: false, status: 'denied' })
  await act(async () => change('active'))
  await waitFor(() => { expect(push.settings?.enabled).toBe(false); expect(push.busy).toBe(false) })
  expect(disablePush).toHaveBeenCalledTimes(1)
  expect(push.permissionDenied).toBe(true)
  expect(getExpoPushToken).toHaveBeenCalledTimes(1)
})
