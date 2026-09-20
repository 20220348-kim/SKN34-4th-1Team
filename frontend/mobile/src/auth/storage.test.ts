import { parseStoredSession, sessionStorageKey } from './storage'

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }))

const now = Date.parse('2026-09-19T00:00:00Z')

test('storage keys isolate API origins and normalize the trailing slash', () => {
  expect(sessionStorageKey('https://api.example.com')).toBe(sessionStorageKey('https://api.example.com/'))
  expect(sessionStorageKey('https://api.example.com')).not.toBe(sessionStorageKey('https://other.example.com'))
  expect(sessionStorageKey('http://192.168.1.2:8080')).toMatch(/^[a-zA-Z0-9._-]+$/)
})

test('expired, corrupt, or missing-token sessions cannot restore authentication', () => {
  expect(parseStoredSession('{', now)).toBeNull()
  expect(parseStoredSession(JSON.stringify({ expiresAt: '2026-09-20T00:00:00Z' }), now)).toBeNull()
  expect(parseStoredSession(JSON.stringify({ accessToken: 'test-token', expiresAt: '2026-09-18T00:00:00Z' }), now)).toBeNull()
  expect(parseStoredSession(JSON.stringify({ accessToken: 'test-token', expiresAt: '2026-09-20T00:00:00Z', password: 'not-retained' }), now)).toEqual({ accessToken: 'test-token', expiresAt: '2026-09-20T00:00:00Z' })
})
