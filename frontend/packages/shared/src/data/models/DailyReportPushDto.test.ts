import { describe, expect, it } from 'vitest'
import { dailyReportNotificationSchema, dailyReportPushRegistrationSchema, dailyReportPushSettingsSchema } from './DailyReportPushDto'

describe('daily report push contracts', () => {
  it('accepts only bounded device tokens and a device UUID', () => {
    expect(dailyReportPushRegistrationSchema.safeParse({ deviceId: 'a4a15267-866c-4df0-bb91-55d7c14d7a72', token: 'ExpoPushToken[test_token]' }).success).toBe(true)
    expect(dailyReportPushRegistrationSchema.safeParse({ deviceId: 'other', token: 'secret' }).success).toBe(false)
  })
  it('rejects arbitrary URLs, other notification types and unsafe report IDs', () => {
    for (const data of [{ url: 'https://attacker.test' }, { type: 'other', reportId: '1', reportDate: '2026-10-02' },
      { type: 'daily-report', reportId: '9007199254740992', reportDate: '2026-10-02' }]) {
      expect(dailyReportNotificationSchema.safeParse(data).success).toBe(false)
    }
    expect(dailyReportNotificationSchema.parse({ type: 'daily-report', reportId: '42', reportDate: '2026-10-02' }).reportId).toBe('42')
  })
  it('requires explicit availability and scheduling status', () => {
    expect(dailyReportPushSettingsSchema.safeParse({ enabled: true, sendHour: 8 }).success).toBe(false)
  })
})
