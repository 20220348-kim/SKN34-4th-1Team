import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { useRootNavigationState, useRouter } from 'expo-router'
import { dailyReportNotificationSchema } from '@govbiz/shared/data/models/DailyReportPushDto'
import type { DailyReportPushSettings } from '@govbiz/shared/domain/entities/DailyReportPush'
import { useAuth } from '../auth/session'
import { ApiError } from '../api/client'
import { disablePush, getPushSettings, registerPush } from '../api/dailyReportPush'
import { getExpoPushToken, getPushDeviceId, notificationModule, supportsPushNotifications } from './device'

type PushState = { settings: DailyReportPushSettings | null; busy: boolean; error: string | null; refresh(): void; toggle(): Promise<void> }
const PushContext = createContext<PushState | null>(null)
export function DailyReportPushProvider({ children }: { children: ReactNode }) {
  const { status, session, invalidateSession } = useAuth()
  const accessToken = status === 'signedIn' ? session?.accessToken : undefined
  const router = useRouter()
  const navigation = useRootNavigationState()
  const [state, setState] = useState<{ token?: string; settings: DailyReportPushSettings | null; busy: boolean; error: string | null }>(
    { settings: null, busy: false, error: null })
  const [revision, setRevision] = useState(0)
  const [pendingReport, setPendingReport] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const activeToken = useRef(accessToken)
  const changingSetting = useRef(false)
  activeToken.current = accessToken
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const failure = useCallback((cause: unknown, token: string) => {
    if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
    if (activeToken.current !== token) return
    setState((current) => ({ ...current, token, busy: false, error: cause instanceof ApiError
      ? cause.status === 503 ? '앱 알림 발송이 현재 준비되지 않았어요.' : '앱 알림 설정을 저장하거나 확인하지 못했어요. 다시 시도해 주세요.'
      : cause instanceof Error ? cause.message : '앱 알림을 연결하지 못했어요.' }))
  }, [invalidateSession])

  useEffect(() => {
    controller.current?.abort()
    if (!accessToken) { setState({ settings: null, busy: false, error: null }); return }
    const request = new AbortController(); controller.current = request
    setState((current) => ({ token: accessToken, settings: current.token === accessToken ? current.settings : null, busy: true, error: null }))
    void (async () => {
      const deviceId = await getPushDeviceId()
      let settings = await getPushSettings(accessToken, deviceId, request.signal)
      if (request.signal.aborted || activeToken.current !== accessToken) return
      setState({ token: accessToken, settings, busy: true, error: null })
      if (settings.enabled && settings.available) {
        const native = await notificationModule()
        const permission = await native.getPermissionsAsync()
        if (request.signal.aborted || activeToken.current !== accessToken) return
        if (permission.granted) {
          const token = await getExpoPushToken(false)
          if (request.signal.aborted || activeToken.current !== accessToken) return
          await registerPush(accessToken, { deviceId, token }, request.signal)
        } else {
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
        const parsed = dailyReportNotificationSchema.safeParse(data)
        if (!disposed && parsed.success) setPendingReport(parsed.data.reportId)
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

  async function toggle() {
    if (!accessToken || state.busy || state.token !== accessToken || !state.settings) return
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
        await registerPush(accessToken, { deviceId, token }, request.signal)
      }
      const settings = await getPushSettings(accessToken, deviceId, request.signal)
      if (!request.signal.aborted && activeToken.current === accessToken) setState({ token: accessToken, settings, busy: false, error: null })
    } catch (cause) { if (!request.signal.aborted) failure(cause, accessToken) }
    finally { changingSetting.current = false }
  }

  const visible = state.token === accessToken ? state : { settings: null, busy: false, error: null }
  return <PushContext.Provider value={{ ...visible, refresh, toggle }}>{children}</PushContext.Provider>
}
export function useDailyReportPush() {
  const context = useContext(PushContext)
  if (!context) throw new Error('DailyReportPushProvider is required')
  return context
}
