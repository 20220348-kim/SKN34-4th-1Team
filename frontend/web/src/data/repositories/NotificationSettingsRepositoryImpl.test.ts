import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettings } from '@govbiz/shared/domain/entities/NotificationSettings'
import { NotificationSettingsRepositoryImpl } from './NotificationSettingsRepositoryImpl'

const settings: NotificationSettings = {
  deadlineReminder: { enabled: true, email: true, push: false },
  emailConfirmed: true, emailDeliveryAvailable: true, pushDeliveryAvailable: false,
  pushDeviceRegistered: false, schedulerEnabled: false, sendHour: 9, reminderDaysBefore: [7, 3, 1],
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('알림 설정 API 경계', () => {
  it('본인 설정 조회·저장은 쿠키와 no-store를 쓰고 마감 알림을 deadlineReminder로 감싸 보낸다', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(settings)).mockResolvedValueOnce(Response.json(settings))
    vi.stubGlobal('fetch', fetcher)
    const repository = new NotificationSettingsRepositoryImpl()
    expect(await repository.settings()).toEqual(settings)
    expect(await repository.saveDeadlineReminder(settings.deadlineReminder)).toEqual(settings)
    expect(fetcher.mock.calls.map(([url, options]) => [new URL(url).pathname, options.method])).toEqual([
      ['/api/v1/me/notification-settings', 'GET'], ['/api/v1/me/notification-settings', 'PUT'],
    ])
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ deadlineReminder: settings.deadlineReminder })
  })

  it('서버 오류 코드만 보존하고 원문은 노출하지 않으며 계약과 다른 응답은 거부한다', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'PUSH_DELIVERY_UNAVAILABLE', detail: 'expo access token missing' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...settings, deadlineReminder: { enabled: true, email: false, push: false } }))
      // 알림 일수를 알려 주지 않는 예전 Core 응답도 계약과 다르게 봅니다.
      .mockResolvedValueOnce(Response.json({ ...settings, reminderDaysBefore: undefined })))
    const repository = new NotificationSettingsRepositoryImpl()
    await expect(repository.settings()).rejects.toMatchObject({ status: 503, code: 'PUSH_DELIVERY_UNAVAILABLE', message: 'PUSH_DELIVERY_UNAVAILABLE' })
    await expect(repository.settings()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' })
    await expect(repository.settings()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' })
  })
})
