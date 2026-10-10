import { disablePush, getPushSettings, registerPush } from './dailyReportPush'

const originalFetch = globalThis.fetch
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL
const deviceId = 'a4a15267-866c-4df0-bb91-55d7c14d7a72'
const settings = { enabled: false, available: true, schedulerEnabled: true, sendHour: 8 }
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'; globalThis.fetch = jest.fn() })
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase
})

test('reading device subscription uses authenticated GET and validates the response without registering', async () => {
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(settings), { status: 200 }))
  await expect(getPushSettings('owned-token', deviceId)).resolves.toEqual(settings)
  const [url, options] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe(`https://api.example.test/api/v1/me/daily-reports/push?deviceId=${deviceId}`)
  expect(options?.method).toBe('GET')
  expect(options?.credentials).toBe('omit')
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer owned-token')
  expect(fetch).toHaveBeenCalledTimes(1)
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...settings, enabled: 'yes' }), { status: 200 }))
  await expect(getPushSettings('owned-token', deviceId)).rejects.toThrow()
})

test('register and disable retain the existing owned PUT and DELETE contracts', async () => {
  jest.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))
  const registration = { deviceId, token: 'ExpoPushToken[test]' }
  await registerPush('owned-token', registration)
  const [url, options] = jest.mocked(fetch).mock.calls[0]
  expect(url).toBe('https://api.example.test/api/v1/me/daily-reports/push')
  expect(options?.method).toBe('PUT')
  expect(JSON.parse(String(options?.body))).toEqual(registration)
  await disablePush('owned-token', deviceId)
  expect(jest.mocked(fetch).mock.calls[1][1]?.method).toBe('DELETE')
  expect(new Headers(jest.mocked(fetch).mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer owned-token')
})

test('invalid registration data is rejected before transmission and failures do not become disabled defaults', async () => {
  await expect(registerPush('owned-token', { deviceId, token: 'https://untrusted.test' })).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 503 }))
  await expect(getPushSettings('owned-token', deviceId)).rejects.toMatchObject({ status: 503 })
})
