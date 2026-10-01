import * as SecureStore from 'expo-secure-store'
import { clearPendingReview, readPendingReview, savePendingReview } from './reviewPending'
import { reviewRequestKey } from '../test/reviewFixtures'

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }))
const entries = new Map<string, string>()
const pending = { reviewId: 5, request: { expectedRevision: 1, requestKey: reviewRequestKey, additionalFacts: 'same cost' } }
beforeEach(() => {
  entries.clear()
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async key => entries.get(key) ?? null)
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => { entries.set(key, value) })
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async key => { entries.delete(key) })
})
test('account and API origins isolate the exact pending request without storing credentials', async () => {
  await savePendingReview('https://api.example.test', 'first@example.test', pending)
  expect(await readPendingReview('https://api.example.test', 'FIRST@example.test')).toEqual(pending)
  expect(await readPendingReview('https://api.example.test', 'second@example.test')).toBeNull()
  expect(await readPendingReview('https://other.example.test', 'first@example.test')).toBeNull()
  expect([...entries.values()][0]).not.toMatch(/accessToken|password/)
  await clearPendingReview('https://api.example.test', 'first@example.test')
  expect(await readPendingReview('https://api.example.test', 'first@example.test')).toBeNull()
})
test('a different request cannot overwrite an unknown outcome', async () => {
  await savePendingReview('https://api.example.test', 'first@example.test', pending)
  await expect(savePendingReview('https://api.example.test', 'first@example.test', { ...pending, reviewId: 7 })).rejects.toThrow('다른 분석 요청')
  expect(await readPendingReview('https://api.example.test', 'first@example.test')).toEqual(pending)
})
test('storage corruption and write failure prevent treating the journal as empty', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('{broken')
  await expect(readPendingReview('https://api.example.test', 'first@example.test')).rejects.toThrow()
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(savePendingReview('https://api.example.test', 'first@example.test', pending)).rejects.toThrow('storage unavailable')
})
