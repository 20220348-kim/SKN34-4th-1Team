import { z } from 'zod'

export const dailyReportPushSettingsSchema = z.object({
  enabled: z.boolean(), available: z.boolean(), schedulerEnabled: z.boolean(), sendHour: z.number().int().min(0).max(23),
})
export const dailyReportPushRegistrationSchema = z.object({
  deviceId: z.string().uuid(), token: z.string().max(200).regex(/^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,160}\]$/),
})
export const dailyReportNotificationSchema = z.object({
  type: z.literal('daily-report'), reportId: z.string().regex(/^[1-9][0-9]*$/)
    .refine((value) => Number.isSafeInteger(Number(value))), reportDate: z.iso.date(),
})
