import { notificationSettingsSchema } from '@govbiz/shared/data/models/NotificationSettingsDto'
import type { DeadlineReminderSetting } from '@govbiz/shared/domain/entities/NotificationSettings'
import type { NotificationSettingsRepository } from '@govbiz/shared/domain/repositories/NotificationSettingsRepository'
import { notificationSettingsRequest as request } from '../api/notificationSettingsApi'

export class NotificationSettingsRepositoryImpl implements NotificationSettingsRepository {
  settings(signal?: AbortSignal) { return request('GET', notificationSettingsSchema, undefined, signal) }
  saveDeadlineReminder(setting: DeadlineReminderSetting, signal?: AbortSignal) {
    return request('PUT', notificationSettingsSchema, { deadlineReminder: setting }, signal)
  }
}
