import * as SecureStore from 'expo-secure-store'

const key = 'govbiz.introduction.v1'
export async function readIntroductionCompleted(): Promise<boolean> {
  const value = await SecureStore.getItemAsync(key)
  if (value !== null && value !== '1') throw new Error('기능 소개 기록을 확인하지 못했습니다.')
  return value === '1'
}
export function completeIntroduction(): Promise<void> {
  return SecureStore.setItemAsync(key, '1', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
}

export function clearIntroductionCompleted(): Promise<void> {
  return SecureStore.deleteItemAsync(key)
}
