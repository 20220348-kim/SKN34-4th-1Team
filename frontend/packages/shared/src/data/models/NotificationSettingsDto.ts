import { z } from 'zod'

export const deadlineReminderSettingSchema = z.object({
  enabled: z.boolean(), daysBefore: z.number().int().min(1).max(7), email: z.boolean(), push: z.boolean(),
}).refine((setting) => !setting.enabled || setting.email || setting.push, { message: '켜진 마감 알림에는 받을 방법이 있어야 합니다.' })

export const notificationSettingsSchema = z.object({
  deadlineReminder: deadlineReminderSettingSchema,
  emailConfirmed: z.boolean(), emailDeliveryAvailable: z.boolean(),
  pushDeliveryAvailable: z.boolean(), pushDeviceRegistered: z.boolean(),
  schedulerEnabled: z.boolean(), sendHour: z.number().int().min(0).max(23),
})

export const notificationSettingsProblemSchema = z.object({ code: z.string() })

/** 마감 알림 앱 푸시의 데이터입니다. 공고 식별자와 마감일만 받고 임의 URL은 받지 않습니다. */
export const deadlineReminderNotificationSchema = z.object({
  type: z.literal('deadline-reminder'),
  sourceCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  sourceProgramId: z.string().min(1).max(255).refine((value) => value === value.trim() && !/\p{C}/u.test(value)),
  dueDate: z.iso.date(),
})
