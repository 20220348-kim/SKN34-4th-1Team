import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState, Linking } from 'react-native'
import { useRootNavigationState, useRouter } from 'expo-router'
import type { DevicePushToken } from 'expo-notifications'
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
  const readController = useRef<AbortController | null>(null)
  const mutation = useRef<{ request: AbortController; token: string; enabled: boolean } | null>(null)
  const activeToken = useRef(accessToken)
  const confirmed = useRef<{ token?: string; settings: DailyReportPushSettings | null }>({ settings: null })
  const registeredExpoToken = useRef<string | null>(null)
  const pendingRefresh = useRef(false)
  const pendingDeviceToken = useRef<{ token: string; deviceToken: DevicePushToken; key: string } | null>(null)
  const syncingDeviceToken = useRef<string | null>(null)
  const syncedDeviceToken = useRef<string | null>(null)
  const processPending = useRef<() => void>(() => undefined)
  activeToken.current = accessToken
  const refresh = useCallback(() => {
    if (mutation.current) { pendingRefresh.current = true; return }
    setRevision((value) => value + 1)
  }, [])
  const failure = useCallback((cause: unknown, token: string, message?: string) => {
    if (activeToken.current !== token) return
    if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
    if (cause instanceof Error && cause.name === 'PushPermissionDeniedError') setPermissionState({ token, denied: true })
    setState((current) => ({ ...current, token, busy: false, error: message ?? (cause instanceof ApiError
      ? cause.status === 503 ? '앱 알림 발송이 현재 준비되지 않았어요.' : '앱 알림 설정을 저장하거나 확인하지 못했어요. 다시 시도해 주세요.'
      : cause instanceof Error ? cause.message : '앱 알림을 연결하지 못했어요.') }))
  }, [invalidateSession])

  const runMutation = useCallback(async (token: string, enabled: boolean, explicit = false, deviceToken?: DevicePushToken, deviceTokenKey?: string) => {
    if (activeToken.current !== token || mutation.current) return
    const request = new AbortController()
    mutation.current = { request, token, enabled }
    syncingDeviceToken.current = deviceTokenKey ?? null
    setState((current) => ({ ...current, busy: true, error: null }))
    const currentRequest = () => !request.signal.aborted && activeToken.current === token
    let sent = false, saved = false, succeeded = false
    try {
      const deviceId = await getPushDeviceId()
      if (!currentRequest()) return
      if (enabled) {
        const expoToken = await (deviceToken ? getExpoPushToken(explicit, deviceToken) : getExpoPushToken(explicit))
        if (!currentRequest()) return
        setPermissionState({ token, denied: false })
        if (explicit || registeredExpoToken.current !== expoToken) {
          sent = true
          await registerPush(token, { deviceId, token: expoToken }, request.signal)
          if (!currentRequest()) return
          saved = true
          registeredExpoToken.current = expoToken
        }
      } else {
        sent = true
        await disablePush(token, deviceId, request.signal)
        if (!currentRequest()) return
        saved = true
        registeredExpoToken.current = null
        pendingDeviceToken.current = null
        syncedDeviceToken.current = null
      }
      // 명시적 전환과 권한 해제는 저장 후 서버 값을 확인하며, 추측으로 스위치를 바꾸지 않습니다.
      if (explicit || !enabled) {
        const settings = await getPushSettings(token, deviceId, request.signal)
        if (!currentRequest()) return
        confirmed.current = { token, settings }
        setState({ token, settings, busy: false, error: null })
        if (settings.enabled !== enabled) {
          failure(new Error('앱 알림 설정이 요청한 상태로 확인되지 않았어요. 다시 확인해 주세요.'), token)
          return
        }
      }
      if (deviceTokenKey) syncedDeviceToken.current = deviceTokenKey
      succeeded = true
    } catch (cause) {
      if (!currentRequest()) return
      failure(cause, token, saved ? '앱 알림 설정을 변경했지만 서버 상태를 확인하지 못했어요. 다시 확인해 주세요.'
        : sent && !(cause instanceof ApiError) ? '앱 알림 설정 변경 결과를 확인하지 못했어요. 다시 확인해 주세요.' : undefined)
    } finally {
      if (mutation.current?.request === request) {
        mutation.current = null
        syncingDeviceToken.current = null
        if (currentRequest()) setState((current) => ({ ...current, busy: false }))
        if (succeeded) processPending.current()
        else { pendingRefresh.current = false; pendingDeviceToken.current = null }
      }
    }
  }, [failure])

  const receiveDeviceToken = useCallback((deviceToken: DevicePushToken) => {
    const token = activeToken.current
    const settings = confirmed.current.token === token ? confirmed.current.settings : null
    if (!token || !(settings?.available && settings.enabled || mutation.current?.token === token && mutation.current.enabled)) return
    const key = JSON.stringify(deviceToken)
    if (key === syncedDeviceToken.current || key === syncingDeviceToken.current || key === pendingDeviceToken.current?.key) return
    pendingDeviceToken.current = { token, deviceToken, key }
    processPending.current()
  }, [])

  processPending.current = () => {
    if (mutation.current || readController.current) return
    if (pendingRefresh.current) { pendingRefresh.current = false; refresh(); return }
    const pending = pendingDeviceToken.current
    pendingDeviceToken.current = null
    const settings = confirmed.current.settings
    if (pending && activeToken.current === pending.token && confirmed.current.token === pending.token && settings?.available && settings.enabled) {
      void runMutation(pending.token, true, false, pending.deviceToken, pending.key)
    }
  }

  useEffect(() => {
    confirmed.current = { token: accessToken, settings: null }
    registeredExpoToken.current = null
    pendingRefresh.current = false
    pendingDeviceToken.current = null
    syncedDeviceToken.current = null
    syncingDeviceToken.current = null
    setPermissionState({ token: accessToken, denied: false })
    return () => {
      readController.current?.abort(); readController.current = null
      mutation.current?.request.abort(); mutation.current = null
      pendingRefresh.current = false; pendingDeviceToken.current = null
    }
  }, [accessToken])

  useEffect(() => {
    readController.current?.abort()
    if (!accessToken) { setState({ settings: null, busy: false, error: null }); return }
    if (mutation.current) { pendingRefresh.current = true; return }
    const request = new AbortController(); readController.current = request
    setState((current) => ({ token: accessToken, settings: current.token === accessToken ? current.settings : null, busy: true, error: null }))
    void (async () => {
      const deviceId = await getPushDeviceId()
      if (request.signal.aborted || activeToken.current !== accessToken) return
      const settings = await getPushSettings(accessToken, deviceId, request.signal)
      if (request.signal.aborted || activeToken.current !== accessToken) return
      confirmed.current = { token: accessToken, settings }
      setState({ token: accessToken, settings, busy: true, error: null })
      let permissionGranted = false
      if (supportsPushNotifications()) {
        const native = await notificationModule()
        const permission = await native.getPermissionsAsync()
        if (request.signal.aborted || activeToken.current !== accessToken) return
        setPermissionState({ token: accessToken, denied: permission.status === 'denied' })
        permissionGranted = permission.granted
      }
      if (request.signal.aborted || activeToken.current !== accessToken) return
      readController.current = null
      setState({ token: accessToken, settings, busy: false, error: null })
      if (supportsPushNotifications() && settings.available && settings.enabled) void runMutation(accessToken, permissionGranted)
      else processPending.current()
    })().catch((cause: unknown) => {
      if (request.signal.aborted || activeToken.current !== accessToken) return
      if (readController.current === request) readController.current = null
      pendingRefresh.current = false; pendingDeviceToken.current = null
      failure(cause, accessToken)
    })
    return () => { request.abort(); if (readController.current === request) readController.current = null }
  }, [accessToken, revision, failure, runMutation])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active') refresh() })
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
      const tokenListener = native.addPushTokenListener((deviceToken) => { if (!disposed) receiveDeviceToken(deviceToken) })
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
  }, [receiveDeviceToken])

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
    if (!accessToken || activeToken.current !== accessToken || state.busy || readController.current || mutation.current || state.token !== accessToken || !state.settings) return
    await runMutation(accessToken, !state.settings.enabled, true)
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
