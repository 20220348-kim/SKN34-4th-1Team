import { describe, expect, it, vi } from 'vitest'
import { type NotificationSettings, turnOnDeadlineReminder } from '../entities/NotificationSettings'
import type { NotificationSettingsRepository } from '../repositories/NotificationSettingsRepository'
import { NotificationSettingsUseCase } from './NotificationSettingsUseCase'

const settings: NotificationSettings = {
  deadlineReminder: { enabled: false, daysBefore: 3, email: false, push: false },
  emailConfirmed: false, emailDeliveryAvailable: true, pushDeliveryAvailable: true,
  pushDeviceRegistered: false, schedulerEnabled: true, sendHour: 9,
}

function repository(): NotificationSettingsRepository {
  return { settings: vi.fn(async () => settings), saveDeadlineReminder: vi.fn(async () => settings) }
}

describe('NotificationSettingsUseCase', () => {
  it('rejects a reminder without a channel or with out-of-range days before calling the server', () => {
    const repo = repository()
    const useCase = new NotificationSettingsUseCase(repo)
    expect(() => useCase.saveDeadlineReminder({ enabled: true, daysBefore: 3, email: false, push: false }))
      .toThrow('알림을 받을 방법을 하나 이상 골라 주세요.')
    expect(() => useCase.saveDeadlineReminder({ enabled: false, daysBefore: 8, email: false, push: false })).toThrow(RangeError)
    expect(repo.saveDeadlineReminder).not.toHaveBeenCalled()
  })

  it('saves a valid setting through the repository', async () => {
    const repo = repository()
    const setting = { enabled: true, daysBefore: 1, email: false, push: true }
    await new NotificationSettingsUseCase(repo).saveDeadlineReminder(setting)
    expect(repo.saveDeadlineReminder).toHaveBeenCalledWith(setting, undefined)
  })
})

describe('turnOnDeadlineReminder', () => {
  it('keeps previously chosen usable channels and drops channels that can no longer deliver', () => {
    const chosen = { ...settings, emailConfirmed: true, deadlineReminder: { enabled: false, daysBefore: 5, email: true, push: true } }
    expect(turnOnDeadlineReminder(chosen)).toEqual({ enabled: true, daysBefore: 5, email: true, push: true })
    expect(turnOnDeadlineReminder({ ...chosen, emailConfirmed: false })).toEqual({ enabled: true, daysBefore: 5, email: false, push: true })
  })

  it('prefers a confirmed email, then a registered device, and refuses when nothing can deliver', () => {
    expect(turnOnDeadlineReminder({ ...settings, emailConfirmed: true })).toEqual({ enabled: true, daysBefore: 3, email: true, push: false })
    expect(turnOnDeadlineReminder({ ...settings, pushDeviceRegistered: true })).toEqual({ enabled: true, daysBefore: 3, email: false, push: true })
    expect(turnOnDeadlineReminder(settings)).toBeNull()
    expect(turnOnDeadlineReminder({ ...settings, emailConfirmed: true, emailDeliveryAvailable: false })).toBeNull()
  })
})
