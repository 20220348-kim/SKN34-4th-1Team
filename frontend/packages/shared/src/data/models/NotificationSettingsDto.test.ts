import { describe, expect, it } from 'vitest'
import { deadlineReminderNotificationSchema, notificationSettingsSchema } from './NotificationSettingsDto'

const settings = {
  deadlineReminder: { enabled: true, email: true, push: false },
  emailConfirmed: true, emailDeliveryAvailable: true, pushDeliveryAvailable: false,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9, reminderDaysBefore: [7, 3, 1],
}

describe('notification settings contracts', () => {
  it('accepts the server settings with explicit delivery state and the fixed reminder days', () => {
    expect(notificationSettingsSchema.parse(settings).reminderDaysBefore).toEqual([7, 3, 1])
    expect(notificationSettingsSchema.safeParse({ ...settings, schedulerEnabled: undefined }).success).toBe(false)
  })

  it('drops a leftover daysBefore field and rejects an enabled reminder without a channel', () => {
    const leftover = { ...settings, deadlineReminder: { enabled: true, daysBefore: 3, email: true, push: false } }
    expect(notificationSettingsSchema.parse(leftover).deadlineReminder).toEqual({ enabled: true, email: true, push: false })
    expect(notificationSettingsSchema.safeParse({ ...settings, deadlineReminder: { enabled: true, email: false, push: false } }).success)
      .toBe(false)
  })

  it('rejects reminder days that are missing, empty, out of range, or not strictly descending', () => {
    for (const reminderDaysBefore of [undefined, [], [0], [31], [1, 3, 7], [3, 3], [7, 3, 1.5]]) {
      expect(notificationSettingsSchema.safeParse({ ...settings, reminderDaysBefore }).success).toBe(false)
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
