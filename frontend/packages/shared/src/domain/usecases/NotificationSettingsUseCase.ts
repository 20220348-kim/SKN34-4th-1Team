import { type DeadlineReminderSetting, findDeadlineReminderProblem } from '../entities/NotificationSettings'
import type { NotificationSettingsRepository } from '../repositories/NotificationSettingsRepository'

/** 본인 알림 설정을 읽고, 화면 검증을 통과한 마감 알림 설정만 서버로 보냅니다. */
export class NotificationSettingsUseCase {
  private readonly repository: NotificationSettingsRepository
  constructor(repository: NotificationSettingsRepository) { this.repository = repository }
  settings(signal?: AbortSignal) { return this.repository.settings(signal) }
  saveDeadlineReminder(setting: DeadlineReminderSetting, signal?: AbortSignal) {
    const problem = findDeadlineReminderProblem(setting)
    if (problem !== null) throw new RangeError(problem)
    return this.repository.saveDeadlineReminder(setting, signal)
  }
}
