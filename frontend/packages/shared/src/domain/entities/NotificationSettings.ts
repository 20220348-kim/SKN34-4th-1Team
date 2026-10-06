import { sendHourLabel } from './DailyReport'

/**
 * 관심 공고 마감 알림 설정입니다. 켜려면 이메일·앱 알림 중 하나 이상을 골라야 합니다.
 * 알림 시점은 고르지 않고 서버가 알려 주는 [NotificationSettings.reminderDaysBefore](마감 7·3·1일 전)마다 한 번씩 보냅니다.
 */
export type DeadlineReminderSetting = { enabled: boolean; email: boolean; push: boolean }

/** 저장한 알림 설정과, 그 설정이 지금 실제로 발송될 수 있는지 판단할 서버 상태입니다. */
export type NotificationSettings = {
  deadlineReminder: DeadlineReminderSetting
  /** 맞춤 리포트 화면에서 확인을 마친 수신 주소가 지금 계정 이메일과 같은지입니다. 마감 알림 이메일도 이 확인을 씁니다. */
  emailConfirmed: boolean
  emailDeliveryAvailable: boolean
  pushDeliveryAvailable: boolean
  /** 앱 알림을 켠 유효한 기기가 하나 이상 있는지입니다. */
  pushDeviceRegistered: boolean
  schedulerEnabled: boolean
  sendHour: number
  /** 마감 며칠 전에 보내는지입니다(큰 값부터, 예: 7·3·1). */
  reminderDaysBefore: number[]
}

/** 마감 알림을 언제 보내는지 한 문장으로 알립니다. 예: "마감 7일·3일·1일 전 오전 9시 이후에 한 번씩 보내요." */
export function deadlineReminderScheduleText(settings: Pick<NotificationSettings, 'reminderDaysBefore' | 'sendHour'>): string {
  const days = settings.reminderDaysBefore.map((value) => `${value}일`).join('·')
  return `마감 ${days} 전 ${sendHourLabel(settings.sendHour)} 이후에 한 번씩 보내요.`
}

/** 저장된 설정을 바꿀 수 없는 이유입니다. 문제가 없으면 null입니다. 서버가 같은 규칙으로 한 번 더 검사합니다. */
export function findDeadlineReminderProblem(setting: DeadlineReminderSetting): string | null {
  if (setting.enabled && !setting.email && !setting.push) return '알림을 받을 방법을 하나 이상 골라 주세요.'
  return null
}

/** 지금 고를 수 있는 채널입니다. 이메일은 발송 설정과 수신 주소 확인이, 앱 알림은 서버 발송 설정이 있어야 합니다. */
export function usableDeadlineReminderChannels(settings: NotificationSettings): { email: boolean; push: boolean } {
  return {
    email: settings.emailDeliveryAvailable && settings.emailConfirmed,
    push: settings.pushDeliveryAvailable,
  }
}

/**
 * 마감 알림을 켤 때 저장할 설정입니다. 전에 고른 채널 중 지금 쓸 수 있는 것을 유지하고, 없으면 이메일, 그다음 앱 알림을 켠
 * 기기가 있을 때 앱 알림을 고릅니다. 받을 방법이 하나도 없으면 null입니다.
 */
export function turnOnDeadlineReminder(settings: NotificationSettings): DeadlineReminderSetting | null {
  const usable = usableDeadlineReminderChannels(settings)
  const current = settings.deadlineReminder
  const kept = { email: current.email && usable.email, push: current.push && usable.push }
  if (kept.email || kept.push) return { ...current, ...kept, enabled: true }
  if (usable.email) return { ...current, enabled: true, email: true, push: false }
  if (usable.push && settings.pushDeviceRegistered) return { ...current, enabled: true, email: false, push: true }
  return null
}
