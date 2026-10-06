import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  type DeadlineReminderSetting,
  type NotificationSettings,
  deadlineReminderScheduleText,
  findDeadlineReminderProblem,
  turnOnDeadlineReminder,
  usableDeadlineReminderChannels,
} from '@govbiz/shared/domain/entities/NotificationSettings'
import { ApiError } from '../api/client'
import { notificationSettingsErrorMessage, notificationSettingsUseCase } from '../api/notificationSettings'
import { useAuth } from '../auth/session'
import { Button, Card, Notice, colors, styles } from '../ui'
import { useDailyReportPush } from './DailyReportPushProvider'

type LoadState = { token: string | null; settings: NotificationSettings | null; loading: boolean; error: string | null }

/**
 * 관심 공고 마감 알림 설정입니다. 웹 프로필과 같은 서버 설정을 shared 유스케이스로 읽고, 바꾸면 바로 저장합니다.
 * 저장하는 동안에는 바꾼 값을 먼저 보여 주되 다른 조작을 막고, 실패하면 저장 전 값으로 되돌립니다.
 * 이 기기 앱 알림을 켜거나 끄면 기기 등록 여부가 바뀌므로 다시 읽습니다.
 */
export function DeadlineReminderSettings() {
  const { session, status, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const devicePushEnabled = useDailyReportPush().settings?.enabled === true
  const [state, setState] = useState<LoadState>({ token, settings: null, loading: true, error: null })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const activeToken = useRef(token)
  activeToken.current = token

  useEffect(() => {
    if (!token) { setState({ token: null, settings: null, loading: false, error: null }); return }
    const controller = new AbortController()
    setState((current) => ({ token, settings: current.token === token ? current.settings : null, loading: true, error: null }))
    notificationSettingsUseCase(token).settings(controller.signal)
      .then((settings) => { if (!controller.signal.aborted) setState({ token, settings, loading: false, error: null }) })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setState((current) => ({ ...current, token, loading: false, error: notificationSettingsErrorMessage(cause) }))
      })
    return () => controller.abort()
  }, [token, revision, devicePushEnabled, invalidateSession])

  if (!token) return null
  const visible = state.token === token ? state : { token, settings: null, loading: true, error: null }
  const settings = visible.settings

  async function save(next: DeadlineReminderSetting) {
    if (!token || !settings || saving) return
    const problem = findDeadlineReminderProblem(next)
    if (problem !== null) { setError(problem); return }
    setState((current) => current.token === token && current.settings
      ? { ...current, settings: { ...current.settings, deadlineReminder: next } } : current)
    setSaving(true); setError(null)
    try {
      const saved = await notificationSettingsUseCase(token).saveDeadlineReminder(next)
      if (activeToken.current === token) setState((current) => current.token === token ? { ...current, settings: saved } : current)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      if (activeToken.current !== token) return
      setState((current) => current.token === token ? { ...current, settings } : current)
      setError(notificationSettingsErrorMessage(cause))
    } finally { setSaving(false) }
  }

  if (!settings) {
    return <Card>
      <Text style={styles.heading}>관심 공고 마감 알림</Text>
      {visible.loading ? <ActivityIndicator accessibilityLabel="마감 알림 설정 불러오는 중" color={colors.primary} />
        : <>
          <Notice error>{visible.error ?? '마감 알림 설정을 확인하지 못했어요.'}</Notice>
          <Button label="마감 알림 설정 다시 확인" variant="ghost" onPress={() => setRevision((value) => value + 1)} />
        </>}
    </Card>
  }

  const setting = settings.deadlineReminder
  const usable = usableDeadlineReminderChannels(settings)
  const blocked = !setting.enabled && turnOnDeadlineReminder(settings) === null
  const channels = [
    { key: 'email' as const, label: '이메일', isOn: setting.email, canTurnOn: usable.email,
      note: !settings.emailDeliveryAvailable ? '지금은 이메일 발송을 사용할 수 없어요.'
        : !settings.emailConfirmed ? '아래에서 리포트 수신 주소를 확인하면 고를 수 있어요.' : '확인한 계정 이메일로 보내요.' },
    { key: 'push' as const, label: '앱 알림', isOn: setting.push, canTurnOn: usable.push,
      note: !settings.pushDeliveryAvailable ? '지금은 앱 알림 발송을 사용할 수 없어요.'
        : settings.pushDeviceRegistered ? '앱 알림을 켠 기기로 보내요.' : '아래에서 이 기기 앱 알림을 켜면 받을 수 있어요.' },
  ]

  const toggleEnabled = () => {
    if (setting.enabled) { void save({ ...setting, enabled: false }); return }
    const next = turnOnDeadlineReminder(settings)
    if (next === null) setError('받을 방법이 아직 없어요. 아래에서 리포트 수신 주소를 확인하거나 이 기기 앱 알림을 켜 주세요.')
    else void save(next)
  }

  return <Card>
    <Pressable accessibilityRole="switch" accessibilityLabel="관심 공고 마감 알림"
      accessibilityState={{ checked: setting.enabled, disabled: saving || blocked, busy: saving }} disabled={saving || blocked}
      onPress={toggleEnabled} style={local.option}>
      <View style={{ flex: 1 }}>
        <Text style={styles.heading}>관심 공고 마감 알림</Text>
        <Text style={styles.muted}>{deadlineReminderScheduleText(settings)}</Text>
      </View>
      <Text style={local.check}>{setting.enabled ? '●' : '○'}</Text>
    </Pressable>
    {setting.enabled && <>
      {channels.map((channel) => <Pressable key={channel.key} accessibilityRole="checkbox" accessibilityLabel={`${channel.label}로 받기`}
        accessibilityState={{ checked: channel.isOn, disabled: saving || (!channel.isOn && !channel.canTurnOn) }}
        disabled={saving || (!channel.isOn && !channel.canTurnOn)}
        onPress={() => void save({ ...setting, [channel.key]: !channel.isOn })} style={local.option}>
        <Text style={local.check}>{channel.isOn ? '☑' : '□'}</Text>
        <View style={{ flex: 1 }}><Text style={styles.body}>{channel.label}</Text><Text style={styles.muted}>{channel.note}</Text></View>
      </Pressable>)}
    </>}
    {blocked && <Notice>받을 방법이 아직 없어요. 아래에서 리포트 수신 주소를 확인하거나 이 기기 앱 알림을 켜 주세요.</Notice>}
    {!settings.schedulerEnabled && <Notice>서버의 마감 알림 발송이 아직 꺼져 있어요. 설정은 미리 저장해 둘 수 있어요.</Notice>}
    {error && <Notice error>{error}</Notice>}
  </Card>
}

const local = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, gap: 8 },
  check: { color: colors.primary, fontSize: 22, fontWeight: '600' },
})
