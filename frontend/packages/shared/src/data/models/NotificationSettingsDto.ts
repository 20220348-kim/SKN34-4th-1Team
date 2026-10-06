import { z } from 'zod'

export const deadlineReminderSettingSchema = z.object({
  enabled: z.boolean(), email: z.boolean(), push: z.boolean(),
}).refine((setting) => !setting.enabled || setting.email || setting.push, { message: '켜진 마감 알림에는 받을 방법이 있어야 합니다.' })

export const notificationSettingsSchema = z.object({
  deadlineReminder: deadlineReminderSettingSchema,
  emailConfirmed: z.boolean(), emailDeliveryAvailable: z.boolean(),
  pushDeliveryAvailable: z.boolean(), pushDeviceRegistered: z.boolean(),
  schedulerEnabled: z.boolean(), sendHour: z.number().int().min(0).max(23),
  // 마감 며칠 전에 보내는지(큰 값부터)입니다. 이 값이 없는 예전 Core 응답은 알림 일정이 달라 읽지 않습니다.
  reminderDaysBefore: z.array(z.number().int().min(1).max(30)).min(1).max(5)
    .refine((days) => days.every((value, index) => index === 0 || value < days[index - 1]), { message: '알림 일수는 큰 값부터 겹치지 않아야 합니다.' }),
})

export const notificationSettingsProblemSchema = z.object({ code: z.string() })

/** 마감 알림 앱 푸시의 데이터입니다. 공고 식별자와 마감일만 받고 임의 URL은 받지 않습니다. */
export const deadlineReminderNotificationSchema = z.object({
  type: z.literal('deadline-reminder'),
  sourceCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  sourceProgramId: z.string().min(1).max(255).refine((value) => value === value.trim() && !/\p{C}/u.test(value)),
  dueDate: z.iso.date(),
})
