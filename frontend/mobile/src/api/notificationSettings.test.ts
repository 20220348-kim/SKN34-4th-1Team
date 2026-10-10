import { notificationSettingsUseCase } from './notificationSettings'

const originalFetch = globalThis.fetch
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL
const settings = { deadlineReminder: { enabled: false, email: false, push: false }, emailConfirmed: true,
  emailDeliveryAvailable: true, pushDeliveryAvailable: true, pushDeviceRegistered: true, schedulerEnabled: true,
  sendHour: 9, reminderDaysBefore: [7, 3, 1] }
beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test'; globalThis.fetch = jest.fn() })
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase
})

test('reminder switches read and save the existing authenticated shared contract', async () => {
  const api = notificationSettingsUseCase('owned-token')
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(settings), { status: 200 }))
  await expect(api.settings()).resolves.toEqual(settings)
  const choice = { enabled: true, email: true, push: false }
  const saved = { ...settings, deadlineReminder: choice }
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }))
  await expect(api.saveDeadlineReminder(choice)).resolves.toEqual(saved)
  const [url, options] = jest.mocked(fetch).mock.calls[1]
  expect(url).toBe('https://api.example.test/api/v1/me/notification-settings')
  expect(options?.method).toBe('PUT')
  expect(options?.credentials).toBe('omit')
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer owned-token')
  expect(JSON.parse(String(options?.body))).toEqual({ deadlineReminder: choice })
})

test('enabling without a channel never sends a request and malformed server state is rejected', async () => {
  const api = notificationSettingsUseCase('owned-token')
  expect(() => api.saveDeadlineReminder({ enabled: true, email: false, push: false })).toThrow(RangeError)
  expect(fetch).not.toHaveBeenCalled()
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...settings, reminderDaysBefore: undefined }), { status: 200 }))
  await expect(api.settings()).rejects.toThrow()
})
