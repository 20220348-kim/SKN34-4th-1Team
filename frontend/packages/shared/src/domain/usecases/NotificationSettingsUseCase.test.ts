import { describe, expect, it, vi } from 'vitest'
import { deadlineReminderScheduleText, type NotificationSettings, turnOnDeadlineReminder } from '../entities/NotificationSettings'
import type { NotificationSettingsRepository } from '../repositories/NotificationSettingsRepository'
import { NotificationSettingsUseCase } from './NotificationSettingsUseCase'

const settings: NotificationSettings = {
  deadlineReminder: { enabled: false, email: false, push: false },
  emailConfirmed: false, emailDeliveryAvailable: true, pushDeliveryAvailable: true,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9, reminderDaysBefore: [7, 3, 1],
}

function repository(): NotificationSettingsRepository {
  return { settings: vi.fn(async () => settings), saveDeadlineReminder: vi.fn(async () => settings) }
}

describe('NotificationSettingsUseCase', () => {
  it('rejects an enabled reminder without a channel before calling the server', () => {
    const repo = repository()
    const useCase = new NotificationSettingsUseCase(repo)
    expect(() => useCase.saveDeadlineReminder({ enabled: true, email: false, push: false }))
      .toThrow('알림을 받을 방법을 하나 이상 골라 주세요.')
    expect(repo.saveDeadlineReminder).not.toHaveBeenCalled()
  })

  it('saves a valid setting through the repository', async () => {
    const repo = repository()
    const setting = { enabled: true, email: false, push: true }
    await new NotificationSettingsUseCase(repo).saveDeadlineReminder(setting)
    expect(repo.saveDeadlineReminder).toHaveBeenCalledWith(setting, undefined)
  })
})

describe('turnOnDeadlineReminder', () => {
  it('keeps previously chosen usable channels and drops channels that can no longer deliver', () => {
    const chosen = { ...settings, emailConfirmed: true, deadlineReminder: { enabled: false, email: true, push: true } }
    expect(turnOnDeadlineReminder(chosen)).toEqual({ enabled: true, email: true, push: true })
    expect(turnOnDeadlineReminder({ ...chosen, emailConfirmed: false })).toEqual({ enabled: true, email: false, push: true })
  })

  it('prefers a confirmed email, then a registered device, and refuses when nothing can deliver', () => {
    expect(turnOnDeadlineReminder({ ...settings, emailConfirmed: true })).toEqual({ enabled: true, email: true, push: false })
    expect(turnOnDeadlineReminder({ ...settings, pushDeviceRegistered: true })).toEqual({ enabled: true, email: false, push: true })
    expect(turnOnDeadlineReminder(settings)).toBeNull()
    expect(turnOnDeadlineReminder({ ...settings, emailConfirmed: true, emailDeliveryAvailable: false })).toBeNull()
  })
})

describe('deadlineReminderScheduleText', () => {
  it('lists every reminder day and the send hour the server reports', () => {
    expect(deadlineReminderScheduleText(settings)).toBe('마감 7일·3일·1일 전 오전 9시 이후에 한 번씩 보내요.')
    expect(deadlineReminderScheduleText({ reminderDaysBefore: [1], sendHour: 14 })).toBe('마감 1일 전 오후 2시 이후에 한 번씩 보내요.')
  })
})
