import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'react-redux'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import type { RootState } from '../../../../app/store'
import type { Company } from '../../../../domain/entities/Company'
import type { DailyReport, DailyReportSettings } from '../../../../domain/entities/DailyReport'
import { dailyReportFailureMessage } from './dailyReportMessages'

type PageState = {
  owner: RootState['auth']
  settings: DailyReportSettings | null
  company: Company | null
  report: DailyReport | null
  supportPurpose: string
  enabled: boolean
  consent: boolean
  loaded: boolean
  busy: string | null
  error: string | null
  notice: string | null
}

const initialState = (owner: RootState['auth']): PageState => ({
  owner, settings: null, company: null, report: null, supportPurpose: '', enabled: false,
  consent: false, loaded: false, busy: null, error: null, notice: null,
})

/** 설정·결과는 현재 세션에만 한정합니다. store 변경 직후에도 이전 계정의 응답을 반영하지 않습니다. */
export function useDailyReportViewModel() {
  const useCase = appContainer.resolve('dailyReportUseCase')
  const companyUseCase = appContainer.resolve('getMyCompanyUseCase')
  const store = useStore<RootState>()
  const auth = useAppSelector((root) => root.auth)
  const [stored, setState] = useState<PageState>(() => initialState(auth))
  const state = stored.owner === auth ? stored : initialState(auth)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const unsubscribe = store.subscribe(() => {
      if (store.getState().auth !== auth) request.current?.abort()
    })
    return () => { mounted.current = false; request.current?.abort(); request.current = null; unsubscribe() }
  }, [auth, store])

  const perform = useCallback(async <T,>(name: string, operation: (signal: AbortSignal) => Promise<T>, accept: (value: T, current: PageState) => PageState) => {
    if (!mounted.current || store.getState().auth !== auth || request.current !== null) return
    const controller = new AbortController()
    request.current = controller
    const current = () => mounted.current && !controller.signal.aborted && store.getState().auth === auth
    setState((old) => ({ ...(old.owner === auth ? old : initialState(auth)), busy: name, error: null, notice: null }))
    try {
      const value = await operation(controller.signal)
      if (current()) setState((old) => accept(value, old))
    } catch (error) {
      if (current()) setState((old) => ({ ...old, error: dailyReportFailureMessage(error) }))
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

  function updateForm(patch: Partial<Pick<PageState, 'supportPurpose' | 'enabled' | 'consent'>>) {
    if (store.getState().auth !== auth) return
    setState((old) => ({ ...old, ...patch, error: null, notice: null }))
  }

  function save(disable = false) {
    if (!state.settings || (state.company === null && !disable)) return
    const input = { supportPurpose: disable ? state.settings.supportPurpose : state.supportPurpose, enabled: disable ? false : state.enabled, consent: disable ? false : state.consent }
    if (input.enabled && !input.consent) {
      setState((old) => ({ ...old, error: '정기 리포트 이메일 수신 동의에 직접 체크해 주세요.' }))
      return
    }
    if (input.supportPurpose.length > 100 || /\p{C}/u.test(input.supportPurpose)) {
      setState((old) => ({ ...old, error: '지원 목적은 제어문자 없이 100자 이하로 입력해 주세요.' }))
      return
    }
    void perform('save', (signal) => useCase.saveSettings(input, signal), (settings, old) => ({
      ...old, settings, supportPurpose: settings.supportPurpose, enabled: settings.enabled, consent: false,
      notice: disable ? '정기 이메일 수신을 중지했습니다.' : '설정을 저장했습니다. 이미 생성된 오늘의 리포트는 변경되지 않습니다.',
    }))
  }

  const dirty = state.settings !== null && (state.supportPurpose.trim() !== state.settings.supportPurpose || state.enabled !== state.settings.enabled)
  return {
    ...state, dirty, account: auth.account, load, updateForm, save,
    verifyEmail: () => perform('verify', (signal) => useCase.verifyEmail(signal), (_, old) => ({ ...old, notice: '확인 메일을 요청했습니다. 메일의 버튼으로 주소를 확인한 뒤 이 화면에서 상태를 새로고침해 주세요. 주소 확인만으로 정기 수신이 시작되지는 않습니다.' })),
    preview: () => perform('preview', (signal) => useCase.preview(signal), (report, old) => ({ ...old, report, notice: '오늘의 리포트를 확인했습니다. 미리보기 버튼은 메일을 발송하지 않습니다.' })),
  }
}
