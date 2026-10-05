import { useEffect, useRef, useState } from 'react'

import { sendHourLabel } from '@govbiz/shared/domain/entities/DailyReport'
import {
  type DeadlineReminderSetting,
  type NotificationSettings,
  deadlineReminderDaysOptions,
  findDeadlineReminderProblem,
  turnOnDeadlineReminder,
  usableDeadlineReminderChannels,
} from '@govbiz/shared/domain/entities/NotificationSettings'
import { NotificationSettingsError } from '@govbiz/shared/domain/errors/NotificationSettingsError'
import type { NotificationSettingsUseCase } from '@govbiz/shared/domain/usecases/NotificationSettingsUseCase'
import { appContainer } from '../../../../app/appContainer'

export const notificationSettingsMessages = {
  loadFailed: '알림 설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
  saveFailed: '알림 설정을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
  emailConfirmationRequired: '맞춤 리포트 화면에서 수신 이메일 주소를 먼저 확인해 주세요.',
  emailUnavailable: '지금은 이메일 발송을 사용할 수 없어요.',
  pushUnavailable: '지금은 앱 알림 발송을 사용할 수 없어요.',
  noChannel: '받을 방법이 아직 없어요. 맞춤 리포트 화면에서 수신 이메일 주소를 확인하거나 모바일 앱에서 이 기기 알림을 켜 주세요.',
  schedulerOff: '서버의 마감 알림 발송이 아직 꺼져 있어요. 설정은 미리 저장해 둘 수 있어요.',
} as const

export type DeadlineReminderChannelKey = 'email' | 'push'

type LoadState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; settings: NotificationSettings }

function errorMessage(cause: unknown): string {
  if (cause instanceof RangeError) return cause.message
  if (cause instanceof NotificationSettingsError) {
    if (cause.code === 'EMAIL_CONFIRMATION_REQUIRED') return notificationSettingsMessages.emailConfirmationRequired
    if (cause.code === 'EMAIL_DELIVERY_UNAVAILABLE') return notificationSettingsMessages.emailUnavailable
    if (cause.code === 'PUSH_DELIVERY_UNAVAILABLE') return notificationSettingsMessages.pushUnavailable
  }
  return notificationSettingsMessages.saveFailed
}

/**
 * 프로필 화면의 알림 설정 ViewModel입니다. 서버에서 읽은 마감 알림 설정을 보여 주고, 바꾸면 바로 저장합니다.
 * 저장하는 동안에는 바꾼 값을 먼저 보여 주되 다른 조작을 막고, 실패하면 저장 전 값으로 되돌린 뒤 이유를 알립니다.
 * 파트너 제안·새 공고 알림은 보내는 기능이 없어 화면에서 준비 중으로만 표시합니다.
 */
export function useNotificationSettingsViewModel(
  useCase: Pick<NotificationSettingsUseCase, 'settings' | 'saveDeadlineReminder'> = appContainer.resolve('notificationSettingsUseCase'),
) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    void Promise.resolve()
      .then(() => useCase.settings(controller.signal))
      .then((settings) => { if (!controller.signal.aborted) setState({ status: 'ready', settings }) })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'failed' }) })
    return () => controller.abort()
    // 화면에 들어올 때와 [다시 시도]를 눌렀을 때만 읽습니다. UseCase는 앱 수명 동안 같습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  async function save(next: DeadlineReminderSetting) {
    if (state.status !== 'ready' || isSaving) return
    const problem = findDeadlineReminderProblem(next)
    if (problem !== null) {
      setError(problem)
      return
    }
    const previous = state.settings
    setState({ status: 'ready', settings: { ...previous, deadlineReminder: next } })
    setIsSaving(true)
    setError(null)
    try {
      const saved = await useCase.saveDeadlineReminder(next)
      if (isMounted.current) setState({ status: 'ready', settings: saved })
    } catch (cause) {
      if (!isMounted.current) return
      setState({ status: 'ready', settings: previous })
      setError(errorMessage(cause))
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  if (state.status !== 'ready') {
    return {
      status: state.status,
      loadFailedMessage: state.status === 'failed' ? notificationSettingsMessages.loadFailed : null,
      retry: () => setRevision((value) => value + 1),
    } as const
  }

  const { settings } = state
  const setting = settings.deadlineReminder
  const usable = usableDeadlineReminderChannels(settings)
  // 꺼져 있을 때 켤 수 있는 받을 방법이 하나도 없으면 스위치를 잠그고 이유를 먼저 보여 줍니다.
  const enableBlocker = !setting.enabled && turnOnDeadlineReminder(settings) === null ? notificationSettingsMessages.noChannel : null

  return {
    status: 'ready',
    setting,
    isSaving,
    error,
    timing: `마감 ${setting.daysBefore}일 전 ${sendHourLabel(settings.sendHour)} 이후에 한 번 보내요.`,
    daysOptions: deadlineReminderDaysOptions,
    enableBlocker,
    schedulerNote: settings.schedulerEnabled ? null : notificationSettingsMessages.schedulerOff,
    channels: [
      {
        key: 'email' as const,
        label: '이메일',
        isOn: setting.email,
        // 끄기는 언제든 되고, 켜기는 지금 보낼 수 있을 때만 됩니다.
        isDisabled: isSaving || (!setting.email && !usable.email),
        note: !settings.emailDeliveryAvailable ? notificationSettingsMessages.emailUnavailable
          : !settings.emailConfirmed ? '맞춤 리포트 화면에서 수신 주소를 확인하면 고를 수 있어요.'
            : '확인한 계정 이메일로 보내요.',
        needsEmailConfirmation: settings.emailDeliveryAvailable && !settings.emailConfirmed,
      },
      {
        key: 'push' as const,
        label: '앱 알림',
        isOn: setting.push,
        isDisabled: isSaving || (!setting.push && !usable.push),
        note: !settings.pushDeliveryAvailable ? notificationSettingsMessages.pushUnavailable
          : settings.pushDeviceRegistered ? '앱 알림을 켠 기기로 보내요.'
            : '모바일 앱에서 이 기기 알림을 켜면 받을 수 있어요.',
        needsEmailConfirmation: false,
      },
    ],
    toggleEnabled: () => {
      if (setting.enabled) {
        void save({ ...setting, enabled: false })
        return
      }
      const next = turnOnDeadlineReminder(settings)
      if (next === null) setError(notificationSettingsMessages.noChannel)
      else void save(next)
    },
    changeDaysBefore: (daysBefore: number) => { void save({ ...setting, daysBefore }) },
    toggleChannel: (channel: DeadlineReminderChannelKey) => { void save({ ...setting, [channel]: !setting[channel] }) },
  } as const
}

export type NotificationSettingsViewModel = ReturnType<typeof useNotificationSettingsViewModel>
