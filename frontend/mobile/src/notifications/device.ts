import Constants from 'expo-constants'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { z } from 'zod'

let devicePromise: Promise<string> | undefined
export function getPushDeviceId(): Promise<string> {
  devicePromise ??= (async () => {
    const stored = await SecureStore.getItemAsync('govbiz.push-device.v1')
    if (stored) return z.string().uuid().parse(stored)
    const id = Crypto.randomUUID()
    await SecureStore.setItemAsync('govbiz.push-device.v1', id)
    return id
  })().catch((cause: unknown) => { devicePromise = undefined; throw cause })
  return devicePromise
}

export function supportsPushNotifications() {
  return Platform.OS !== 'web' && Constants.executionEnvironment !== 'storeClient'
}

export async function notificationModule() {
  if (!supportsPushNotifications()) {
    throw new Error('앱 알림은 Expo Go 대신 개발용 앱을 설치한 뒤 사용할 수 있어요.')
  }
  return import('expo-notifications')
}

export async function getExpoPushToken(requestPermission: boolean): Promise<string> {
  const notifications = await notificationModule()
  const projectId = Constants.expoConfig?.extra?.eas?.projectId
  if (typeof projectId !== 'string' || !projectId) throw new Error('앱 알림 연결 설정이 준비되지 않았어요.')
  if (Platform.OS === 'android') {
    await notifications.setNotificationChannelAsync('daily-reports', {
      name: '맞춤 리포트', importance: notifications.AndroidImportance.DEFAULT,
    })
    // 서버가 마감 알림을 이 채널로 보냅니다. 채널이 없으면 Android가 알림을 표시하지 않습니다.
    await notifications.setNotificationChannelAsync('deadline-reminders', {
      name: '관심 공고 마감 알림', importance: notifications.AndroidImportance.DEFAULT,
    })
  }
  let permission = await notifications.getPermissionsAsync()
  if (requestPermission && !permission.granted) permission = await notifications.requestPermissionsAsync()
  if (!permission.granted) throw new Error('기기 설정에서 GovBiz 알림을 허용해 주세요.')
  try { return (await notifications.getExpoPushTokenAsync({ projectId })).data }
  catch { throw new Error('앱 알림 토큰을 받지 못했어요. 네트워크와 앱 연결 설정을 확인해 주세요.') }
}
