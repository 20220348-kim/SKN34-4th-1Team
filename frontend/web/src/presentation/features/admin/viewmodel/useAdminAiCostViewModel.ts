import { type FormEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import { useAppDispatch } from '../../../../app/hooks'
import {
  adminAiCostMaxDays,
  aiServiceTierLabels,
  aiUsageFeatureLabel,
  defaultAdminAiCostPeriod,
  formatAiCostUsd,
  type AdminAiCostSummary,
  type AdminAiModelPrice,
  type AiServiceTier,
  type AiUsageTotals,
} from '../../../../domain/entities/AdminAiCost'
import { planLabels, type PlanCode } from '@govbiz/shared/domain/entities/PlanUsage'
import {
  adminAiCostPeriodIssue,
  type AddAdminAiModelPriceUseCase,
  type GetAdminAiCostSummaryUseCase,
  type GetAdminAiModelPricesUseCase,
  type SyncAdminAiCostsUseCase,
} from '../../../../domain/usecases/AdminAiCostUseCases'
import { signedOut } from '../../../shared/auth/state/authSlice'
import { appPaths } from '../../../shared/routes/appPaths'
import { adminAccessFailure, adminAccessMessages } from './adminAccountAccess'
import { formatAdminDateTime } from './adminAccountFormat'

type UseCases = {
  getSummary: Pick<GetAdminAiCostSummaryUseCase, 'execute'>
  sync: Pick<SyncAdminAiCostsUseCase, 'execute'>
  getPrices: Pick<GetAdminAiModelPricesUseCase, 'execute'>
  addPrice: Pick<AddAdminAiModelPriceUseCase, 'execute'>
}

export const adminAiCostMessages = {
  failed: 'AI 비용을 불러오지 못했어요.',
  loading: 'AI 비용을 불러오는 중이에요.',
  period: {
    'invalid-date': '날짜를 다시 골라 주세요.',
    'reversed-period': '시작일이 종료일보다 늦어요. 기간을 다시 골라 주세요.',
    'too-long': `한 번에 ${adminAiCostMaxDays}일까지 볼 수 있어요.`,
  },
  basis: '추정 비용은 요청마다 기록한 토큰에 그날의 가격표를 곱한 값(서울 날짜)이고, 실제 비용은 OpenAI가 알려 준 하루(UTC) 비용이에요. '
    + 'OpenAI 집계는 몇 시간 늦게 반영될 수 있어 최근 날짜는 다음에 가져올 때 바뀔 수 있어요.',
  actualMissingKey: 'OpenAI 조직 관리자 키(OPENAI_ADMIN_KEY)가 없어 실제 비용을 가져올 수 없어요. 프로젝트 키로는 조회되지 않아요.',
  actualNeverFetched: '아직 실제 비용을 가져오지 않았어요.',
  sync: {
    done: (lines: number, usd: string) => `실제 비용 ${lines}줄(합계 $${usd})을 가져왔어요.`,
    'admin-key-missing': 'OpenAI 조직 관리자 키가 설정되지 않았어요.',
    'admin-key-rejected': 'OpenAI가 관리자 키를 거절했어요. 조직 관리자 키인지 확인해 주세요.',
    unavailable: 'OpenAI 비용을 지금 가져오지 못했어요. 기존 값은 그대로 두었어요.',
    failed: '실제 비용을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
  price: {
    added: '가격을 더했어요. 시작일부터 새 요청에 적용해요.',
    conflict: '같은 모델·처리 등급·시작일의 가격이 이미 있어요.',
    invalid: '모델 이름(소문자)·처리 등급·0 이상의 가격·시작일을 확인해 주세요.',
    failed: '가격을 더하지 못했어요. 잠시 후 다시 시도해 주세요.',
  },
} as const

type PriceForm = {
  modelPrefix: string
  serviceTier: AiServiceTier
  inputUsdPerMillion: string
  cachedInputUsdPerMillion: string
  outputUsdPerMillion: string
  effectiveFrom: string
  note: string
}

const emptyPriceForm = (today: string): PriceForm => ({
  modelPrefix: '', serviceTier: 'default', inputUsdPerMillion: '', cachedInputUsdPerMillion: '', outputUsdPerMillion: '', effectiveFrom: today, note: '',
})

function tokens(totals: AiUsageTotals): string {
  const cached = totals.cachedInputTokens > 0 ? ` (캐시 ${totals.cachedInputTokens.toLocaleString('ko-KR')})` : ''
  return `입력 ${totals.inputTokens.toLocaleString('ko-KR')}${cached} · 출력 ${totals.outputTokens.toLocaleString('ko-KR')}`
}

function unpriced(totals: AiUsageTotals): string | null {
  return totals.unpricedCalls > 0 ? `가격 없는 호출 ${totals.unpricedCalls}회 제외` : null
}

/** 추정과 실제의 차이입니다. 실제 비용이 없으면 null입니다. */
function difference(summary: AdminAiCostSummary): string | null {
  if (summary.actualUsd === null) return null
  const diff = Number(summary.actualUsd) - Number(summary.totals.estimatedUsd)
  const sign = diff >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(diff).toFixed(6)}`
}

/**
 * 관리자 AI 비용 화면의 대표 ViewModel입니다. 기간(서울 날짜)의 추정·실제 비용 요약, 기능·모델·날짜·회원별 합계, 가격표와 가격 추가,
 * 실제 비용 가져오기를 맡습니다. 세션이 끝났으면(401) 로그인 상태를 비우고, 권한이 없으면(403) 권한 안내를 보여 줍니다.
 */
export function useAdminAiCostViewModel(useCases: Partial<UseCases> = {}, now: () => number = Date.now) {
  const [resolved] = useState<UseCases>(() => ({
    getSummary: useCases.getSummary ?? appContainer.resolve('getAdminAiCostSummaryUseCase'),
    sync: useCases.sync ?? appContainer.resolve('syncAdminAiCostsUseCase'),
    getPrices: useCases.getPrices ?? appContainer.resolve('getAdminAiModelPricesUseCase'),
    addPrice: useCases.addPrice ?? appContainer.resolve('addAdminAiModelPriceUseCase'),
  }))
  const dispatch = useAppDispatch()
  const [initial] = useState(() => defaultAdminAiCostPeriod(now()))
  const [form, setForm] = useState(initial)
  const [period, setPeriod] = useState(initial)
  const [formError, setFormError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'forbidden' | 'signed-out'>('loading')
  const [summary, setSummary] = useState<AdminAiCostSummary | null>(null)
  const [prices, setPrices] = useState<AdminAiModelPrice[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [priceForm, setPriceForm] = useState<PriceForm>(() => emptyPriceForm(initial.to))
  const [priceError, setPriceError] = useState<string | null>(null)
  const [savingPrice, setSavingPrice] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setPhase('loading')
    void Promise.all([
      resolved.getSummary.execute(period.from, period.to, controller.signal),
      resolved.getPrices.execute(controller.signal),
    ]).then(([nextSummary, nextPrices]) => {
      if (controller.signal.aborted) return
      setSummary(nextSummary)
      setPrices(nextPrices)
      setPhase('ready')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const access = adminAccessFailure(error)
      if (access === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setPhase(access === 'forbidden' ? 'forbidden' : 'failed')
    })
    return () => controller.abort()
  }, [period, version, resolved, dispatch])

  function submitPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const issue = adminAiCostPeriodIssue(form.from, form.to)
    if (issue !== null) {
      setFormError(adminAiCostMessages.period[issue])
      return
    }
    setFormError(null)
    if (form.from === period.from && form.to === period.to) setVersion((value) => value + 1)
    else setPeriod({ ...form })
  }

  async function syncActual() {
    if (syncing) return
    setSyncing(true)
    setNotice(null)
    try {
      const result = await resolved.sync.execute()
      if (!isMounted.current) return
      if (result.outcome === 'done') {
        setNotice(adminAiCostMessages.sync.done(result.lines, result.amountUsd))
        setVersion((value) => value + 1)
      } else {
        setNotice(adminAiCostMessages.sync[result.outcome])
      }
    } catch (error) {
      if (!isMounted.current) return
      if (adminAccessFailure(error) === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setNotice(adminAccessFailure(error) === 'forbidden' ? adminAccessMessages.forbidden : adminAiCostMessages.sync.failed)
    } finally {
      if (isMounted.current) setSyncing(false)
    }
  }

  async function submitPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingPrice) return
    const values = priceForm
    if (values.modelPrefix.trim() === '' || values.inputUsdPerMillion.trim() === '' || values.outputUsdPerMillion.trim() === '') {
      setPriceError(adminAiCostMessages.price.invalid)
      return
    }
    setSavingPrice(true)
    setPriceError(null)
    try {
      const result = await resolved.addPrice.execute({
        modelPrefix: values.modelPrefix,
        serviceTier: values.serviceTier,
        inputUsdPerMillion: values.inputUsdPerMillion.trim(),
        cachedInputUsdPerMillion: values.cachedInputUsdPerMillion.trim() || null,
        outputUsdPerMillion: values.outputUsdPerMillion.trim(),
        effectiveFrom: values.effectiveFrom,
        note: values.note,
      })
      if (!isMounted.current) return
      if (result.outcome === 'done') {
        setPrices((current) => [...current, result.price])
        setPriceForm(emptyPriceForm(initial.to))
        setNotice(adminAiCostMessages.price.added)
      } else {
        setPriceError(adminAiCostMessages.price[result.outcome])
      }
    } catch (error) {
      if (!isMounted.current) return
      if (adminAccessFailure(error) === 'signed-out') {
        setPhase('signed-out')
        dispatch(signedOut())
        return
      }
      setPriceError(adminAccessFailure(error) === 'forbidden' ? adminAccessMessages.forbidden : adminAiCostMessages.price.failed)
    } finally {
      if (isMounted.current) setSavingPrice(false)
    }
  }

  const rate = summary?.krwPerUsd ?? null
  return {
    phase,
    retry: () => setVersion((value) => value + 1),
    notice,
    dismissNotice: () => setNotice(null),
    basis: adminAiCostMessages.basis,
    form: {
      values: form,
      updateFrom: (value: string) => { setForm((current) => ({ ...current, from: value })); setFormError(null) },
      updateTo: (value: string) => { setForm((current) => ({ ...current, to: value })); setFormError(null) },
      submit: submitPeriod,
      error: formError,
    },
    stats: summary === null ? [] : [
      { label: '추정 비용', value: formatAiCostUsd(summary.totals.estimatedUsd, rate), note: unpriced(summary.totals) },
      {
        label: '실제 비용(OpenAI)',
        value: summary.actualUsd === null ? '없음' : formatAiCostUsd(summary.actualUsd, rate),
        note: summary.actualUsd !== null
          ? (summary.actualFetchedAt === null ? null : `${formatAdminDateTime(summary.actualFetchedAt)} 가져옴`)
          : summary.actualConfigured ? adminAiCostMessages.actualNeverFetched : adminAiCostMessages.actualMissingKey,
      },
      { label: '차이(실제 − 추정)', value: difference(summary) ?? '—', note: null },
      { label: 'AI 호출', value: `${summary.totals.calls.toLocaleString('ko-KR')}회`, note: tokens(summary.totals) },
    ],
    sync: {
      configured: summary?.actualConfigured ?? false,
      busy: syncing,
      run: () => void syncActual(),
    },
    byFeature: (summary?.byFeature ?? []).map((group) => ({
      key: group.key ?? 'system',
      label: aiUsageFeatureLabel(group.key),
      calls: `${group.totals.calls.toLocaleString('ko-KR')}회`,
      tokens: tokens(group.totals),
      cost: formatAiCostUsd(group.totals.estimatedUsd, rate),
      note: unpriced(group.totals),
    })),
    byModel: (summary?.byModel ?? []).map((group) => ({
      key: `${group.key}:${group.serviceTier}`,
      label: group.key,
      tier: group.serviceTier in aiServiceTierLabels ? aiServiceTierLabels[group.serviceTier as AiServiceTier] : group.serviceTier,
      calls: `${group.totals.calls.toLocaleString('ko-KR')}회`,
      tokens: tokens(group.totals),
      cost: group.totals.unpricedCalls === group.totals.calls ? '가격 없음' : formatAiCostUsd(group.totals.estimatedUsd, rate),
    })),
    days: (summary?.days ?? []).filter((day) => day.calls > 0 || day.actualUsd !== null).map((day) => ({
      date: day.date,
      calls: `${day.calls.toLocaleString('ko-KR')}회`,
      estimated: formatAiCostUsd(day.estimatedUsd),
      actual: day.actualUsd === null ? '—' : formatAiCostUsd(day.actualUsd),
    })),
    topAccounts: (summary?.topAccounts ?? []).map((account) => ({
      id: account.accountId,
      email: account.email,
      path: `${appPaths.adminAccountDetail}?accountId=${account.accountId}`,
      plan: account.planCode !== null && account.planCode in planLabels ? planLabels[account.planCode as PlanCode] : '무료',
      calls: `${account.totals.calls.toLocaleString('ko-KR')}회`,
      cost: formatAiCostUsd(account.totals.estimatedUsd, rate),
    })),
    prices: prices.map((price) => ({
      id: price.id,
      model: price.modelPrefix,
      tier: aiServiceTierLabels[price.serviceTier],
      input: `$${price.inputUsdPerMillion}`,
      cached: price.cachedInputUsdPerMillion === null ? '—' : `$${price.cachedInputUsdPerMillion}`,
      output: `$${price.outputUsdPerMillion}`,
      effectiveFrom: price.effectiveFrom,
      note: price.note ?? '',
    })),
    priceForm: {
      values: priceForm,
      tierOptions: (Object.keys(aiServiceTierLabels) as AiServiceTier[]).map((tier) => ({ value: tier, label: aiServiceTierLabels[tier] })),
      update: (field: keyof PriceForm, value: string) => {
        setPriceForm((current) => ({ ...current, [field]: value }))
        setPriceError(null)
      },
      submit: submitPrice,
      error: priceError,
      busy: savingPrice,
    },
  }
}
