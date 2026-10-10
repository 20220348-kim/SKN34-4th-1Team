import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState, Linking } from 'react-native'
import { useRootNavigationState, useRouter } from 'expo-router'
import { dailyReportNotificationSchema } from '@govbiz/shared/data/models/DailyReportPushDto'
import { deadlineReminderNotificationSchema } from '@govbiz/shared/data/models/NotificationSettingsDto'
import type { DailyReportPushSettings } from '@govbiz/shared/domain/entities/DailyReportPush'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { useAuth } from '../auth/session'
import { ApiError } from '../api/client'
import { disablePush, getPushSettings, registerPush } from '../api/dailyReportPush'
import { getExpoPushToken, getPushDeviceId, notificationModule, supportsPushNotifications } from './device'

type PushState = { settings: DailyReportPushSettings | null; busy: boolean; error: string | null; permissionDenied: boolean; refresh(): void; toggle(): Promise<void>; openSystemSettings(): Promise<void> }
const PushContext = createContext<PushState | null>(null)
export function DailyReportPushProvider({ children }: { children: ReactNode }) {
  const { status, session, invalidateSession } = useAuth()
  const accessToken = status === 'signedIn' ? session?.accessToken : undefined
  const router = useRouter()
  const navigation = useRootNavigationState()
  const [state, setState] = useState<{ token?: string; settings: DailyReportPushSettings | null; busy: boolean; error: string | null }>(
    { settings: null, busy: false, error: null })
  const [revision, setRevision] = useState(0)
  const [permissionState, setPermissionState] = useState<{ token?: string; denied: boolean }>({ denied: false })
  const [pendingReport, setPendingReport] = useState<string | null>(null)
  const [pendingProgram, setPendingProgram] = useState<SupportProgramIdentity | null>(null)
  const controller = useRef<AbortController | null>(null)
  const activeToken = useRef(accessToken)
  const changingSetting = useRef(false)
  activeToken.current = accessToken
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const failure = useCallback((cause: unknown, token: string) => {
    if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
    if (activeToken.current !== token) return
    if (cause instanceof Error && cause.name === 'PushPermissionDeniedError') setPermissionState({ token, denied: true })
    setState((current) => ({ ...current, token, busy: false, error: cause instanceof ApiError
      ? cause.status === 503 ? '앱 알림 발송이 현재 준비되지 않았어요.' : '앱 알림 설정을 저장하거나 확인하지 못했어요. 다시 시도해 주세요.'
      : cause instanceof Error ? cause.message : '앱 알림을 연결하지 못했어요.' }))
  }, [invalidateSession])

  useEffect(() => {
    controller.current?.abort()
    changingSetting.current = false
    setPermissionState(current => current.token === accessToken ? current : { token: accessToken, denied: false })
    if (!accessToken) { setState({ settings: null, busy: false, error: null }); return }
    const request = new AbortController(); controller.current = request
    setState((current) => ({ token: accessToken, settings: current.token === accessToken ? current.settings : null, busy: true, error: null }))
    void (async () => {
      const deviceId = await getPushDeviceId()
      let settings = await getPushSettings(accessToken, deviceId, request.signal)
      if (request.signal.aborted || activeToken.current !== accessToken) return
      setState({ token: accessToken, settings, busy: true, error: null })
      if (supportsPushNotifications()) {
        const native = await notificationModule()
        const permission = await native.getPermissionsAsync()
        if (request.signal.aborted || activeToken.current !== accessToken) return
        setPermissionState({ token: accessToken, denied: permission.status === 'denied' })
        if (settings.available && settings.enabled && permission.granted) {
          const token = await getExpoPushToken(false)
          if (request.signal.aborted || activeToken.current !== accessToken) return
          await registerPush(accessToken, { deviceId, token }, request.signal)
        } else if (settings.available && settings.enabled) {
          await disablePush(accessToken, deviceId, request.signal)
          settings = { ...settings, enabled: false }
        }
      }
      if (!request.signal.aborted && activeToken.current === accessToken) setState({ token: accessToken, settings, busy: false, error: null })
    })().catch((cause: unknown) => { if (!request.signal.aborted) failure(cause, accessToken) })
    return () => request.abort()
  }, [accessToken, revision, failure])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active' && !changingSetting.current) refresh() })
    return () => subscription.remove()
  }, [refresh])

  useEffect(() => {
    if (!supportsPushNotifications()) return
    let disposed = false
    let remove: (() => void) | undefined
    void notificationModule().then(async (native) => {
      if (disposed) return
      native.setNotificationHandler({ handleNotification: async () => ({
        shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
      }) })
      const receive = (data: unknown) => {
        if (disposed) return
        const report = dailyReportNotificationSchema.safeParse(data)
        if (report.success) { setPendingReport(report.data.reportId); return }
        // 마감 알림은 공고 식별자만 받아 공개 공고 상세를 엽니다. 임의 URL은 열지 않습니다.
        const reminder = deadlineReminderNotificationSchema.safeParse(data)
        if (reminder.success) setPendingProgram({ sourceCode: reminder.data.sourceCode, sourceProgramId: reminder.data.sourceProgramId })
      }
      const listener = native.addNotificationResponseReceivedListener((response) => {
        receive(response.notification.request.content.data)
        void native.clearLastNotificationResponseAsync()
      })
      const tokenListener = native.addPushTokenListener(() => refresh())
      remove = () => { listener.remove(); tokenListener.remove() }
      const last = await native.getLastNotificationResponseAsync()
      if (!disposed && last) {
        receive(last.notification.request.content.data)
        await native.clearLastNotificationResponseAsync()
      }
    }).catch(() => {
      if (!disposed) setState((current) => ({ ...current, error: '앱 알림 수신 연결을 초기화하지 못했어요. 앱을 다시 실행해 주세요.' }))
    })
    return () => { disposed = true; remove?.() }
  }, [refresh])

  useEffect(() => {
    if (!navigation?.key || !pendingReport) return
    if (status === 'signedIn') {
      router.navigate({ pathname: '/(tabs)/report', params: { reportId: pendingReport } })
      setPendingReport(null)
    } else if (status === 'signedOut') router.navigate('/(tabs)/all/account')
  }, [navigation?.key, pendingReport, router, status])

  useEffect(() => {
    if (!navigation?.key || !pendingProgram) return
    router.push({ pathname: '/program', params: pendingProgram })
    setPendingProgram(null)
  }, [navigation?.key, pendingProgram, router])

  async function toggle() {
    if (!accessToken || activeToken.current !== accessToken || state.busy || changingSetting.current || state.token !== accessToken || !state.settings) return
    const request = new AbortController(); controller.current?.abort(); controller.current = request
    changingSetting.current = true
    setState((current) => ({ ...current, busy: true, error: null }))
    try {
      const deviceId = await getPushDeviceId()
      if (request.signal.aborted || activeToken.current !== accessToken) return
      if (state.settings.enabled) await disablePush(accessToken, deviceId, request.signal)
      else {
        const token = await getExpoPushToken(true)
        if (request.signal.aborted || activeToken.current !== accessToken) return
        setPermissionState({ token: accessToken, denied: false })
        await registerPush(accessToken, { deviceId, token }, request.signal)
      }
      const settings = await getPushSettings(accessToken, deviceId, request.signal)
      if (!request.signal.aborted && activeToken.current === accessToken) setState({ token: accessToken, settings, busy: false, error: null })
    } catch (cause) { if (!request.signal.aborted) failure(cause, accessToken) }
    finally { if (controller.current === request) changingSetting.current = false }
  }

  async function openSystemSettings() {
    const token = accessToken
    try { await Linking.openSettings() }
    catch { if (activeToken.current === token) setState(current => ({ ...current, error: '기기 설정을 열지 못했어요. 직접 기기 설정에서 GovBiz 알림을 확인해 주세요.' })) }
  }

  const visible = state.token === accessToken ? state : { settings: null, busy: false, error: null }
  return <PushContext.Provider value={{ ...visible, permissionDenied: permissionState.token === accessToken && permissionState.denied, refresh, toggle, openSystemSettings }}>{children}</PushContext.Provider>
}
export function useDailyReportPush() {
  const context = useContext(PushContext)
  if (!context) throw new Error('DailyReportPushProvider is required')
  return context
}
