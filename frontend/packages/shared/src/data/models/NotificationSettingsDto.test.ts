import { describe, expect, it } from 'vitest'
import { deadlineReminderNotificationSchema, notificationSettingsSchema } from './NotificationSettingsDto'

const settings = {
  deadlineReminder: { enabled: true, daysBefore: 3, email: true, push: false },
  emailConfirmed: true, emailDeliveryAvailable: true, pushDeliveryAvailable: false,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9,
}

describe('notification settings contracts', () => {
  it('accepts the server settings with explicit delivery state', () => {
    expect(notificationSettingsSchema.parse(settings).deadlineReminder.daysBefore).toBe(3)
    expect(notificationSettingsSchema.safeParse({ ...settings, schedulerEnabled: undefined }).success).toBe(false)
  })

  it('rejects out-of-range days and an enabled reminder without a channel', () => {
    for (const deadlineReminder of [
      { enabled: false, daysBefore: 0, email: false, push: false },
      { enabled: false, daysBefore: 8, email: false, push: false },
      { enabled: true, daysBefore: 3, email: false, push: false },
    ]) {
      expect(notificationSettingsSchema.safeParse({ ...settings, deadlineReminder }).success).toBe(false)
    }
  })

  it('opens only program identities from reminder notifications, never URLs or other types', () => {
    expect(deadlineReminderNotificationSchema.parse({
      type: 'deadline-reminder', sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', dueDate: '2026-10-07',
    }).sourceProgramId).toBe('PBLN_1')
    for (const data of [
      { url: 'https://attacker.test' },
      { type: 'daily-report', sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', dueDate: '2026-10-07' },
      { type: 'deadline-reminder', sourceCode: 'bizinfo', sourceProgramId: 'PBLN_1', dueDate: '2026-10-07' },
      { type: 'deadline-reminder', sourceCode: 'BIZINFO', sourceProgramId: ' PBLN_1', dueDate: '2026-10-07' },
      { type: 'deadline-reminder', sourceCode: 'BIZINFO', sourceProgramId: 'PBLN_1', dueDate: 'tomorrow' },
    ]) {
      expect(deadlineReminderNotificationSchema.safeParse(data).success).toBe(false)
    }
  })
})
