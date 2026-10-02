import * as SecureStore from 'expo-secure-store'
import { clearIntroductionCompleted, completeIntroduction, readIntroductionCompleted } from './introductionStorage'

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }))
test('an absent introduction record is first launch, and completed records survive later launches', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null).mockResolvedValueOnce('1')
  await expect(readIntroductionCompleted()).resolves.toBe(false)
  await expect(readIntroductionCompleted()).resolves.toBe(true)
  await completeIntroduction()
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith('govbiz.introduction.v1', '1', { keychainAccessible: 'device-only' })
})
test('unreadable records do not silently become first launch or completed launch', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('bad').mockRejectedValueOnce(new Error('storage'))
  await expect(readIntroductionCompleted()).rejects.toThrow()
  await expect(readIntroductionCompleted()).rejects.toThrow('storage')
})

test('replaying introduction deletes only its completion record', async () => {
  await clearIntroductionCompleted()
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1)
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('govbiz.introduction.v1')
})
