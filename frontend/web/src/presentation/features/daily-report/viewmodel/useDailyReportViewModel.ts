import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'react-redux'
import { useSearchParams } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { RootState } from '../../../../app/store'
import type { Company } from '../../../../domain/entities/Company'
import type { DailyReport, DailyReportSettings } from '../../../../domain/entities/DailyReport'
import type { WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'
import { dailyReportFailureMessage } from './dailyReportMessages'
import { reportToday } from './dailyReportPeriod'

/** 만드는 중인 리포트를 다시 읽는 간격입니다. */
export const dailyReportPollMs = 5_000

type Operation = 'load' | 'save' | 'verify' | 'preview'
/** 오류를 일어난 자리에 보여 주기 위한 위치입니다. consent · purpose는 저장 전 입력 검사입니다. */
type ErrorSource = Operation | 'consent' | 'purpose'

type PageState = {
  owner: RootState['auth']
  settings: DailyReportSettings | null
  company: Company | null
  report: DailyReport | null
  supportPurpose: string
  enabled: boolean
  consent: boolean
  /** 수신 설정 카드를 펼쳤는지와, 그 안에서 고치는 중인지입니다. */
  settingsOpen: boolean
  editing: boolean
  loaded: boolean
  busy: Operation | null
  error: { at: ErrorSource; text: string } | null
  notice: WorkspaceToastNotice | null
}

const initialState = (owner: RootState['auth'], settingsOpen = false): PageState => ({
  owner, settings: null, company: null, report: null, supportPurpose: '', enabled: false,
  consent: false, settingsOpen, editing: settingsOpen, loaded: false, busy: null, error: null, notice: null,
})

const isDirty = (state: PageState) => state.settings !== null
  && (state.supportPurpose.trim() !== state.settings.supportPurpose || state.enabled !== state.settings.enabled)

/** 설정·결과는 현재 세션에만 한정합니다. store 변경 직후에도 이전 계정의 응답을 반영하지 않습니다. */
export function useDailyReportViewModel() {
  const useCase = appContainer.resolve('dailyReportUseCase')
  const companyUseCase = appContainer.resolve('getMyCompanyUseCase')
  const store = useStore<RootState>()
  const auth = useAppSelector((root) => root.auth)
  // 주소에 `?settings=open`이 있으면(리포트 메일 화면의 [수신 설정 열기]) 수신 설정을 펼쳐 바로 고칠 수 있게 엽니다.
  const [searchParams] = useSearchParams()
  const settingsOpenByLink = searchParams.get('settings') === 'open'
  const [stored, setState] = useState<PageState>(() => initialState(auth, settingsOpenByLink))
  const state = stored.owner === auth ? stored : initialState(auth)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const noticeSequence = useRef(0)
  const toast = (text: string): WorkspaceToastNotice => ({ id: ++noticeSequence.current, text })

  useEffect(() => {
    mounted.current = true
    const unsubscribe = store.subscribe(() => {
      if (store.getState().auth !== auth) request.current?.abort()
    })
    return () => { mounted.current = false; request.current?.abort(); request.current = null; unsubscribe() }
  }, [auth, store])

  const perform = useCallback(async <T,>(name: Operation, operation: (signal: AbortSignal) => Promise<T>, accept: (value: T, current: PageState) => PageState) => {
    if (!mounted.current || store.getState().auth !== auth || request.current !== null) return
    const controller = new AbortController()
    request.current = controller
    const current = () => mounted.current && !controller.signal.aborted && store.getState().auth === auth
    setState((old) => ({ ...(old.owner === auth ? old : initialState(auth)), busy: name, error: null, notice: null }))
    try {
      const value = await operation(controller.signal)
      if (current()) setState((old) => accept(value, old))
    } catch (error) {
      if (current()) setState((old) => ({ ...old, error: { at: name, text: dailyReportFailureMessage(error) } }))
    } finally {
      if (request.current === controller) request.current = null
      if (current()) setState((old) => ({ ...old, busy: null }))
    }
  }, [auth, store])

  const load = useCallback(() => perform('load', async (signal) => {
    const [settings, company, report] = await Promise.all([useCase.settings(signal), companyUseCase.execute(signal), useCase.latest(signal)])
    return { settings, company, report }
  }, (value, old) => ({ ...old, ...value, supportPurpose: value.settings.supportPurpose, enabled: value.settings.enabled, consent: false, loaded: true })), [perform, useCase, companyUseCase])

  useEffect(() => { void load() }, [load])

  // 정기 생성이나 다른 탭에서 만들고 있는 리포트는 끝날 때까지 조용히 다시 읽습니다. 실패한 조회는 다음 주기에 다시 시도합니다.
  const generating = state.report?.status === 'GENERATING'
  useEffect(() => {
    if (!generating) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      useCase.latest(controller.signal).then((report) => {
        if (mounted.current && !controller.signal.aborted && store.getState().auth === auth) setState((old) => old.owner === auth ? { ...old, report } : old)
      }).catch(() => undefined)
    }, dailyReportPollMs)
    return () => { clearInterval(timer); controller.abort() }
  }, [generating, auth, store, useCase])

  // 메일의 확인·해지 링크는 다른 탭에서 처리되므로, 이 탭으로 돌아오면 수신 상태만 조용히 다시 읽습니다. 고치는 중에는 입력을 덮어쓰지 않습니다.
  const loaded = state.loaded
  useEffect(() => {
    if (!loaded) return
    const controller = new AbortController()
    const refresh = () => {
      useCase.settings(controller.signal).then((settings) => {
        if (!mounted.current || controller.signal.aborted || store.getState().auth !== auth) return
        setState((old) => old.owner !== auth || old.busy !== null || old.editing ? old
          : { ...old, settings, supportPurpose: settings.supportPurpose, enabled: settings.enabled, consent: false })
      }).catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh); controller.abort() }
  }, [loaded, auth, store, useCase])

  function updateForm(patch: Partial<Pick<PageState, 'supportPurpose' | 'enabled' | 'consent'>>) {
    if (store.getState().auth !== auth) return
    setState((old) => ({ ...old, ...patch, error: null }))
  }

  /** 보기에서 [수정]을 누르면 저장된 설정으로 채운 폼을 엽니다. */
  function startEditing() {
    if (store.getState().auth !== auth || !state.settings) return
    const settings = state.settings
    setState((old) => ({ ...old, editing: true, supportPurpose: settings.supportPurpose, enabled: settings.enabled, consent: false, error: null }))
  }

  /** 고치던 입력을 버리고 보기로 돌아갑니다. */
  function cancelEditing() {
    if (store.getState().auth !== auth || !state.settings) return
    const settings = state.settings
    setState((old) => ({ ...old, editing: false, supportPurpose: settings.supportPurpose, enabled: settings.enabled, consent: false, error: null }))
  }

  function save() {
    // 정기 수신을 켜려면 기업 정보가 있어야 합니다. 끄는 저장은 기업 정보가 없어도 됩니다.
    if (!state.settings || (state.enabled && state.company === null)) return
    const input = { supportPurpose: state.supportPurpose, enabled: state.enabled, consent: state.enabled && state.consent }
    if (input.enabled && !input.consent) {
      setState((old) => ({ ...old, error: { at: 'consent', text: '정기 리포트 이메일 수신 동의에 직접 체크해 주세요.' } }))
      return
    }
    if (input.supportPurpose.length > 100 || /\p{C}/u.test(input.supportPurpose)) {
      setState((old) => ({ ...old, error: { at: 'purpose', text: '지원 목적은 제어문자 없이 100자 이하로 입력해 주세요.' } }))
      return
    }
    const stopping = state.settings.enabled && !input.enabled
    void perform('save', (signal) => useCase.saveSettings(input, signal), (settings, old) => ({
      ...old, settings, supportPurpose: settings.supportPurpose, enabled: settings.enabled, consent: false, editing: false,
      notice: toast(stopping ? '정기 이메일 수신을 중지했어요.' : '수신 설정을 저장했어요. 이미 만든 오늘 리포트는 바뀌지 않아요.'),
    }))
  }

  return {
    ...state, dirty: isDirty(state), today: reportToday(), account: auth.account, settingsOpenByLink, load, updateForm, startEditing, cancelEditing, save,
    toggleSettings: () => setState((old) => ({ ...old, settingsOpen: !old.settingsOpen })),
    dismissNotice: () => setState((old) => ({ ...old, notice: null })),
    verifyEmail: () => perform('verify', (signal) => useCase.verifyEmail(signal), (_, old) => ({
      ...old, notice: toast('확인 메일을 보냈어요. 메일의 버튼으로 주소를 확인한 뒤 수신 동의를 저장해 주세요.'),
    })),
    // 서버는 생성에 실패해도 실패 상태의 리포트를 돌려주므로, 완성됐을 때만 알립니다. 이 요청은 메일을 보내지 않습니다.
    preview: () => perform('preview', (signal) => useCase.preview(signal), (report, old) => ({
      ...old, report, notice: report?.status === 'READY' ? toast('오늘의 리포트를 만들었어요.') : null,
    })),
  }
}
