import * as Notifications from 'expo-notifications'
import { getExpoPushToken, PushPermissionDeniedError } from './device'

jest.mock('expo-constants', () => ({ __esModule: true, default: {
  executionEnvironment: 'standalone', expoConfig: { extra: { eas: { projectId: 'push-project' } } },
} }))
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(), AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}))

const granted = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>
beforeEach(() => {
  jest.mocked(Notifications.getPermissionsAsync).mockReset().mockResolvedValue(granted)
  jest.mocked(Notifications.requestPermissionsAsync).mockReset().mockResolvedValue(granted)
  jest.mocked(Notifications.getExpoPushTokenAsync).mockReset().mockResolvedValue({ type: 'expo', data: 'ExpoPushToken[device]' })
})

test('SDK token events use their native token to obtain an Expo token without another device-token read', async () => {
  const deviceToken: Notifications.DevicePushToken = { type: 'android', data: 'native-token' }
  expect(await getExpoPushToken(false, deviceToken)).toBe('ExpoPushToken[device]')
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'push-project', devicePushToken: deviceToken })
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
})

test('explicit enable requests missing permission before obtaining the Expo token', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({ ...granted, granted: false, status: Notifications.PermissionStatus.UNDETERMINED })
  expect(await getExpoPushToken(true)).toBe('ExpoPushToken[device]')
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1)
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'push-project' })
})

test('automatic token renewal never requests permission or hides denied permission', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({ ...granted, granted: false, status: Notifications.PermissionStatus.DENIED })
  await expect(getExpoPushToken(false, { type: 'android', data: 'native-token' })).rejects.toBeInstanceOf(PushPermissionDeniedError)
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled()
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled()
})

test('Expo lookup failures remain explicit rather than returning a native token or fallback', async () => {
  jest.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValueOnce(new TypeError('network lost'))
  await expect(getExpoPushToken(false, { type: 'android', data: 'native-token' })).rejects.toThrow('앱 알림 토큰을 받지 못했어요.')
})
