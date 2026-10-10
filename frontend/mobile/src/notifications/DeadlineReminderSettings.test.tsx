import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { NotificationSettings } from '@govbiz/shared/domain/entities/NotificationSettings'
import { ApiError, apiRequest } from '../api/client'
import { useAuth } from '../auth/session'
import { useDailyReportPush } from './DailyReportPushProvider'
import { DeadlineReminderSettings } from './DeadlineReminderSettings'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('./DailyReportPushProvider', () => ({ useDailyReportPush: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), apiRequest: jest.fn() }))

const path = '/api/v1/me/notification-settings'
const settings: NotificationSettings = {
  deadlineReminder: { enabled: false, email: false, push: false },
  emailConfirmed: true, emailDeliveryAvailable: true, pushDeliveryAvailable: true,
  pushDeviceRegistered: true, schedulerEnabled: true, sendHour: 9, reminderDaysBefore: [7, 3, 1],
}
const invalidateSession = jest.fn()

beforeEach(() => {
  invalidateSession.mockReset().mockResolvedValue(undefined)
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: { email: 'member@example.test' } },
    invalidateSession } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(useDailyReportPush).mockReturnValue({ settings: null, busy: false, error: null, permissionDenied: false, openSystemSettings: jest.fn(), refresh: jest.fn(), toggle: jest.fn() })
  jest.mocked(apiRequest).mockReset().mockResolvedValue(settings)
})

test('turning on saves the confirmed email through the shared contract and keeps controls locked while saving', async () => {
  let finish!: (value: unknown) => void
  jest.mocked(apiRequest).mockImplementation((_path, options) => options?.method === 'PUT'
    ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(settings))
  render(<DeadlineReminderSettings />)
  const toggle = await screen.findByLabelText('관심 공고 마감 알림')
  expect(screen.getByText('마감 7일·3일·1일 전 오전 9시 이후에 한 번씩 보내요.')).toBeTruthy()
  expect(screen.queryByText('알림 시점')).toBeNull()
  fireEvent(toggle, 'valueChange', true)
  expect(apiRequest).toHaveBeenLastCalledWith(path, expect.objectContaining({
    method: 'PUT', accessToken: 'owner', body: { deadlineReminder: { enabled: true, email: true, push: false } },
  }))
  expect(screen.getByLabelText('관심 공고 마감 알림').props.accessibilityState).toMatchObject({ checked: true, disabled: true })
  expect(screen.getByLabelText('앱 알림로 받기').props.accessibilityState.disabled).toBe(true)
  await act(async () => finish({ ...settings, deadlineReminder: { enabled: true, email: true, push: false } }))
  await waitFor(() => expect(screen.getByLabelText('관심 공고 마감 알림').props.accessibilityState.disabled).toBe(false))
  fireEvent(screen.getByLabelText('앱 알림로 받기'), 'valueChange', true)
  expect(apiRequest).toHaveBeenLastCalledWith(path, expect.objectContaining({
    method: 'PUT', body: { deadlineReminder: { enabled: true, email: true, push: true } },
  }))
})

test('server rejection restores the previous state and explains the stable error code', async () => {
  jest.mocked(apiRequest).mockImplementation((_path, options) => options?.method === 'PUT'
    ? Promise.reject(new ApiError(409, '요청을 처리하지 못했습니다.', 'EMAIL_CONFIRMATION_REQUIRED')) : Promise.resolve(settings))
  render(<DeadlineReminderSettings />)
  fireEvent(await screen.findByLabelText('관심 공고 마감 알림'), 'valueChange', true)
  expect(await screen.findByText('아래에서 리포트 수신 주소를 먼저 확인해 주세요.')).toBeTruthy()
  expect(screen.getByLabelText('관심 공고 마감 알림').props.accessibilityState.checked).toBe(false)
})

test('without a usable channel the switch stays locked and explains how to enable delivery', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ ...settings, emailConfirmed: false, pushDeviceRegistered: false })
  render(<DeadlineReminderSettings />)
  const toggle = await screen.findByLabelText('관심 공고 마감 알림')
  expect(toggle.props.accessibilityState.disabled).toBe(true)
  expect(screen.getByText('받을 방법이 아직 없어요. 아래에서 리포트 수신 주소를 확인하거나 이 기기 앱 알림을 켜 주세요.')).toBeTruthy()
  fireEvent(toggle, 'valueChange', true)
  expect(jest.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
})

test('malformed server settings are an explicit error instead of a default switch', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ ...settings, deadlineReminder: { enabled: true, email: false, push: false } })
  render(<DeadlineReminderSettings />)
  expect(await screen.findByLabelText('마감 알림 설정 다시 확인')).toBeTruthy()
  expect(screen.queryByLabelText('관심 공고 마감 알림')).toBeNull()
})

test('settings from a Core that does not report the reminder days are rejected instead of guessing the schedule', async () => {
  jest.mocked(apiRequest).mockResolvedValue({ ...settings, reminderDaysBefore: undefined })
  render(<DeadlineReminderSettings />)
  expect(await screen.findByLabelText('마감 알림 설정 다시 확인')).toBeTruthy()
})
