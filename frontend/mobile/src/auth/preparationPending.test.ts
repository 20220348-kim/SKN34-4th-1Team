import * as SecureStore from 'expo-secure-store'
import { clearPendingPreparation, readPendingPreparation, savePendingPreparation } from './preparationPending'
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }))
const record = { kind: 'document' as const, preparationId: 9, expectedRevision: 1, requestKey: '11111111-1111-4111-8111-111111111111' }
beforeEach(() => { jest.mocked(SecureStore.getItemAsync).mockReset().mockResolvedValue(null); jest.mocked(SecureStore.setItemAsync).mockReset().mockResolvedValue(undefined); jest.mocked(SecureStore.deleteItemAsync).mockReset().mockResolvedValue(undefined) })
test('retains only identifiers and binds the request to account and API origin', async () => {
  await savePendingPreparation('https://api.test', 'first@test.com', record)
  const firstKey = jest.mocked(SecureStore.setItemAsync).mock.calls[0][0]
  expect(jest.mocked(SecureStore.setItemAsync).mock.calls[0][1]).toBe(JSON.stringify(record))
  await savePendingPreparation('https://api.test', 'second@test.com', record)
  expect(jest.mocked(SecureStore.setItemAsync).mock.calls[1][0]).not.toBe(firstKey)
  await clearPendingPreparation('https://api.test', 'first@test.com')
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(firstKey)
})
test('cannot replace an unconfirmed request or silently ignore corrupt storage', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify(record))
  await expect(savePendingPreparation('https://api.test', 'first@test.com', { ...record, expectedRevision: 2 })).rejects.toThrow('이전 문서 요청')
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue('invalid-json')
  await expect(readPendingPreparation('https://api.test', 'first@test.com')).rejects.toThrow('보관한 문서 요청')
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})
