import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { companyDtoSchema, toCompany } from '@govbiz/shared/data/models/CompanyDto'
import { savedSupportProgramDtoSchema } from '@govbiz/shared/data/models/SavedSupportProgramDto'
import type { Company } from '@govbiz/shared/domain/entities/Company'
import { sendHourLabel, type DailyReport, type DailyReportItem, type DailyReportSettings } from '@govbiz/shared/domain/entities/DailyReport'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { AppIcon } from '../components/AppIcon'
import { ApiError, apiRequest, errorMessage } from '../api/client'
import { listSavedPrograms } from '../api/savedPrograms'
import { dailyReportErrorMessage, getDailyReportSettings, getLatestDailyReport,
  requestDailyReportEmailVerification, saveDailyReportSettings, getDailyReport } from '../api/dailyReport'
import { DailyReportPushSettings } from '../notifications/DailyReportPushSettings'
import { DeadlineReminderSettings } from '../notifications/DeadlineReminderSettings'
import { useDailyReportPush } from '../notifications/DailyReportPushProvider'
import { useAuth } from '../auth/session'
import { GuestFeatureNotice } from '../components/GuestFeatureNotice'
import { Button, Card, Field, Notice, Page, StatusBadge, colors, styles } from '../ui'

type ReportState = {
  token: string | null; reportId?: string; settings: DailyReportSettings | null; company: Company | null
  report: DailyReport | null; saved: Set<string> | null; savedError: string | null; loading: boolean; error: string | null
}
const emptyState = (token: string | null, reportId?: string): ReportState => ({
  token, reportId, settings: null, company: null, report: null, saved: null, savedError: null, loading: true, error: null,
})
const programKey = (identity: SupportProgramIdentity) => JSON.stringify([identity.sourceCode, identity.sourceProgramId])

function reportDateLabel(date: string) {
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) ?? []
  return month && day ? `${Number(month)}월 ${Number(day)}일 리포트` : '맞춤 리포트'
}

function generatedTimeLabel(value: string | null) {
  if (!value) return '생성 시각 확인 중'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '생성 시각 확인 중'
    : `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit', hour12: true }).format(date)} 생성`
}

const deliveryLabels: Record<DailyReport['deliveryStatus'], string> = {
  NOT_REQUESTED: '메일 발송 대기', SENDING: '메일 발송 중', SENT: '메일 서버 접수',
  UNKNOWN: '발송 결과 확인 필요', SKIPPED: '메일 발송 안 함',
}

function reportNotices(warnings: string[]) {
  return [...new Set(warnings.flatMap((warning) => {
    if (warning.startsWith('관련도 점수는 ') || warning.startsWith('정확한 설립일·')
      || warning.startsWith('현재 조건에 추천할 접수 중 공고를 찾지 못했습니다.')
      || warning.includes(' 최근 수집 성공: ')) return []
    if (warning.startsWith('일부 제공처가 준비 중이거나 최근 수집에 실패했습니다.')) {
      return ['일부 제공처 공고가 이번 추천에서 빠졌을 수 있어요.']
    }
    if (warning.startsWith('일부 공고의 원문 근거 분석에 실패했습니다.')) {
      return ['일부 공고의 원문 근거를 확인하지 못했어요. 공식 원문을 확인해 주세요.']
    }
    return [warning]
  }))]
}

function nextReportMessage(settings: DailyReportSettings, hasCompany: boolean, pushEnabled: boolean) {
  if (!hasCompany) return '기업 정보를 등록하면 지역·업종 조건으로 리포트를 받을 수 있어요.'
  const nextReport = `다음 리포트는 서울 시간 ${sendHourLabel(settings.sendHour)} 이후 생성될 예정이에요.`
  if (pushEnabled && settings.schedulerEnabled) return nextReport
  if (!settings.enabled) return '수신 설정을 켜면 정기 리포트를 받을 수 있어요.'
  if (!settings.emailConfirmed) return '수신 주소를 확인하면 정기 리포트를 받을 수 있어요.'
  if (!settings.emailDeliveryAvailable || !settings.schedulerEnabled) return '정기 발송이 현재 준비되지 않았어요. 설정 상태를 확인해 주세요.'
  return nextReport
}

function completeness(company: Company | null, purpose: string) {
  return Math.round(([Boolean(company?.region), Boolean(company?.industry), Boolean(purpose.trim())]
    .filter(Boolean).length / 3) * 100)
}

function periodLabel(period: string) {
  const range = /^(\d{4})[-.](\d{2})[-.](\d{2})\s*~\s*(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(period)
  if (!range) {
    const normalized = period.normalize('NFKC').replace(/\s+/g, '')
    if (/예산소진|상시/.test(normalized)
      && !/접수종료|모집종료|마감완료|접수예정|추후공지/.test(normalized)) {
      return { status: '접수 중', deadline: null }
    }
    return null
  }
  const [, sy, sm, sd, ey, em, ed] = range
  const start = Date.UTC(Number(sy), Number(sm) - 1, Number(sd))
  const end = Date.UTC(Number(ey), Number(em) - 1, Number(ed))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const startDate = new Date(start)
  const endDate = new Date(end)
  if (startDate.getUTCFullYear() !== Number(sy) || startDate.getUTCMonth() + 1 !== Number(sm) || startDate.getUTCDate() !== Number(sd)
    || endDate.getUTCFullYear() !== Number(ey) || endDate.getUTCMonth() + 1 !== Number(em) || endDate.getUTCDate() !== Number(ed)) return null
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  const today = Date.UTC(part('year'), part('month') - 1, part('day'))
  if (today < start) return { status: '접수 예정', deadline: `${Number(sm)}.${sd} 시작` }
  if (today > end) return { status: '마감', deadline: `${Number(em)}.${ed} 마감` }
  return { status: '접수 중', deadline: `D-${Math.round((end - today) / 86_400_000)}` }
}

export function DailyReportScreen({ onLogin, onCompany, onSearch, onOpenProgram, settingsOnly = false, reportId }: {
  settingsOnly?: boolean
  reportId?: string
  onLogin(mode?: 'login' | 'signup'): void; onCompany(): void; onSearch(): void; onOpenProgram(identity: SupportProgramIdentity): void
}) {
  const { session, status, refreshSession, invalidateSession } = useAuth()
  const push = useDailyReportPush()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [state, setState] = useState<ReportState>(() => emptyState(token, reportId))
  const [revision, setRevision] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [purpose, setPurpose] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)

  const loadSavedPrograms = useCallback(async (owner: string, signal: AbortSignal) => {
    setState(current => current.token === owner && current.reportId === reportId ? { ...current, saved: null, savedError: null } : current)
    try {
      const saved = new Set((await listSavedPrograms(owner, signal))
        .map(({ program }) => programKey({ sourceCode: program.sourceCode, sourceProgramId: program.id })))
      if (!signal.aborted) setState(current => current.token === owner && current.reportId === reportId ? { ...current, saved, savedError: null } : current)
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState(current => current.token === owner && current.reportId === reportId ? { ...current, saved: null, savedError: errorMessage(cause) } : current)
    }
  }, [reportId, invalidateSession])

  useFocusEffect(useCallback(() => {
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    setBusy(null); setNotice(null); setActionError(null)
    if (!token) { setState(emptyState(null, reportId)); setRefreshing(false); return () => controller.abort() }
    setState((current) => current.token === token && current.reportId === reportId && current.settings
      ? { ...current, loading: false, error: null } : emptyState(token, reportId))
    setRefreshing(true)
    void (async () => {
      try {
        const [settings, company, report] = await Promise.all([
          getDailyReportSettings(token, controller.signal),
          apiRequest('/api/v1/me/company', { accessToken: token, signal: controller.signal }).then((value) => toCompany(companyDtoSchema.parse(value)))
            .catch((cause: unknown) => {
              if (cause instanceof ApiError && cause.status === 404 && cause.code === 'COMPANY_NOT_REGISTERED') return null
              throw cause
            }),
          settingsOnly ? Promise.resolve(null) : reportId ? getDailyReport(token, reportId, controller.signal) : getLatestDailyReport(token, controller.signal),
        ])
        if (!controller.signal.aborted) {
          setState({ token, reportId, settings, company, report, saved: report?.programs.length ? null : new Set(), savedError: null, loading: false, error: null })
          setPurpose(settings.supportPurpose); setEnabled(settings.enabled); setConsent(false)
          setRefreshing(false)
          if (report?.programs.length) await loadSavedPrograms(token, controller.signal)
        }
      } catch (cause) {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setState((current) => current.token === token && current.reportId === reportId && current.settings
          ? { ...current, error: dailyReportErrorMessage(cause), loading: false }
          : { ...emptyState(token, reportId), loading: false, error: dailyReportErrorMessage(cause) })
        setRefreshing(false)
      }
    })()
    return () => { controller.abort(); request.current?.abort() }
  }, [token, revision, invalidateSession, settingsOnly, reportId, loadSavedPrograms]))

  const visible = state.token === token && state.reportId === reportId ? state : emptyState(token, reportId)
  const settings = visible.settings
  const canSave = Boolean(token && settings && !busy)
  const refresh = () => { if (!busy) setRevision((value) => value + 1) }

  async function retrySavedPrograms() {
    if (!token || busy || refreshing) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    await loadSavedPrograms(token, controller.signal)
  }

  async function saveSettings() {
    if (!token || !settings || busy) return
    if (purpose.length > 100 || /\p{C}/u.test(purpose)) { setActionError('지원 목적은 100자 이내로 입력해 주세요.'); return }
    if (enabled && !visible.company) { setActionError('기업 정보를 먼저 등록해 주세요.'); return }
    if (enabled && (!settings.emailConfirmed || !settings.emailDeliveryAvailable)) {
      setActionError('수신 주소 확인과 이메일 발송 설정이 필요합니다.'); return
    }
    if (enabled && !consent) { setActionError('정기 이메일 수신 동의에 체크해 주세요.'); return }
    const controller = new AbortController(); request.current = controller
    setBusy('save'); setActionError(null); setNotice(null)
    try {
      const saved = await saveDailyReportSettings(token, { supportPurpose: purpose.trim(), enabled, consent: enabled && consent }, controller.signal)
      if (controller.signal.aborted) return
      setState((current) => current.token === token ? { ...current, settings: saved } : current)
      setPurpose(saved.supportPurpose); setEnabled(saved.enabled); setConsent(false)
      setNotice('수신 설정을 저장했어요. 이미 생성된 리포트의 조건은 바뀌지 않아요.')
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setActionError(dailyReportErrorMessage(cause))
    } finally { if (request.current === controller) setBusy(null) }
  }

  async function verifyEmail() {
    if (!token || !settings?.emailDeliveryAvailable || busy) return
    const controller = new AbortController(); request.current = controller
    setBusy('verify'); setActionError(null); setNotice(null)
    try {
      await requestDailyReportEmailVerification(token, controller.signal)
      if (!controller.signal.aborted) setNotice('확인 메일을 요청했어요. 메일에서 주소 확인을 마친 뒤 이 화면으로 돌아오세요.')
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setActionError(dailyReportErrorMessage(cause))
    } finally { if (request.current === controller) setBusy(null) }
  }

  async function toggleSaved(item: DailyReportItem) {
    if (!token || busy || visible.saved === null) return
    const identity = { sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }
    const key = programKey(identity)
    const controller = new AbortController(); request.current = controller
    setBusy(key); setActionError(null); setNotice(null)
    try {
      if (visible.saved.has(key)) {
        const query = new URLSearchParams(identity)
        await apiRequest(`/api/v1/me/saved-programs?${query}`, { method: 'DELETE', accessToken: token, signal: controller.signal })
      } else savedSupportProgramDtoSchema.parse(await apiRequest('/api/v1/me/saved-programs', {
        method: 'POST', body: identity, accessToken: token, signal: controller.signal,
      }))
      if (controller.signal.aborted) return
      setState((current) => {
        if (current.token !== token || current.saved === null) return current
        const saved = new Set(current.saved)
        if (saved.has(key)) saved.delete(key); else saved.add(key)
        return { ...current, saved }
      })
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setActionError(errorMessage(cause))
    } finally { if (request.current === controller) setBusy(null) }
  }

  async function openSource(url: string) {
    try { await Linking.openURL(url) } catch { setActionError('공식 공고 원문을 열지 못했습니다. 다시 시도해 주세요.') }
  }

  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" color={colors.primary} /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice>
    <Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><GuestFeatureNotice title={settingsOnly ? '알림 설정' : '우리 기업에 맞는 기회를 받아보세요'} icon="report"
    description={settingsOnly ? '로그인하면 관심 공고 마감 알림과 리포트 수신 설정을 바꿀 수 있어요.' : '로그인하면 기업 조건에 맞춘 리포트를 확인할 수 있어요.'}
    onLogin={onLogin} /></Page>
  if (visible.loading) return <Page><ActivityIndicator accessibilityLabel="맞춤 리포트 불러오는 중" color={colors.primary} /></Page>
  if (visible.error && !visible.settings) return <Page><Notice error>{visible.error}</Notice><Button label="다시 시도" onPress={refresh} /></Page>
  if (!settings) return <Page><Notice error>리포트 수신 설정을 확인하지 못했습니다.</Notice><Button label="다시 시도" onPress={refresh} /></Page>

  const report = visible.report
  const ready = report?.status === 'READY'
  return <Page refreshing={refreshing} onRefresh={refresh}>
    {visible.error && <Notice error>{visible.error}</Notice>}
    {!settingsOnly && (report ? <>
      <View style={local.dateLine}><Text style={local.dateTitle}>{reportDateLabel(report.reportDate)}</Text>
        <Text style={local.dateMeta}>{generatedTimeLabel(report.generatedAt)} · {deliveryLabels[report.deliveryStatus]}</Text></View>
      <Card><Text style={styles.heading}>{report.region} · {report.industry} 조건으로 {ready
        ? `${report.programs.length}건을 골랐어요` : '리포트 결과를 확인하고 있어요'}</Text>
        <Text style={styles.muted}>관련도는 검색 순위용 점수예요. 신청 자격과 서류는 공고 원문에서 확인해 주세요.</Text>
        {report.supportPurpose ? <Text style={styles.muted}>지원 목적: {report.supportPurpose}</Text> : null}</Card>
      {reportNotices(report.warnings).map((warning) => <Text key={warning} accessibilityLiveRegion="polite" style={local.reportNotice}>ⓘ {warning}</Text>)}
      {report.status === 'GENERATING' && <Notice>리포트를 생성 중이에요. 잠시 후 화면을 당겨 상태를 확인해 주세요.</Notice>}
      {report.status === 'FAILED' && <Notice error>리포트를 생성하지 못했어요. 검색 결과가 없다는 뜻은 아니에요. 잠시 후 상태를 확인해 주세요.</Notice>}
      {ready && report.programs.length === 0 && <Notice>이번 리포트에서 추천할 공고를 찾지 못했어요. 전체 공고가 없다는 뜻은 아니에요.</Notice>}
      {ready && report.programs.length > 0 && visible.saved === null && !visible.savedError && <ActivityIndicator accessibilityLabel="관심 공고 저장 상태 확인 중" color={colors.primary} />}
      {visible.savedError && <><Notice error>관심 공고 저장 상태를 확인하지 못했어요. {visible.savedError}</Notice>
        <Button label="저장 상태 다시 확인" variant="secondary" disabled={Boolean(busy) || refreshing} onPress={() => void retrySavedPrograms()} /></>}
      {ready && report.programs.map((item) => <ReportProgramCard key={programKey({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId })}
        item={item} saved={visible.saved === null ? null : visible.saved.has(programKey({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }))}
        busy={Boolean(busy)} onOpen={() => onOpenProgram({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId })}
        onSource={() => void openSource(item.sourceUrl)} onToggle={() => void toggleSaved(item)} />)}
    </> : <>
      <Card><Text style={styles.heading}>{nextReportMessage(settings, Boolean(visible.company), push.settings?.enabled === true)}</Text>
        {visible.company && <Text style={styles.muted}>{visible.company.companyName} · {visible.company.region} · {visible.company.industry} 조건으로 접수 중인 공고를 골라 드려요.</Text>}
        <Button label="지원사업 검색하기" onPress={onSearch} /></Card>
      <Card><View style={local.dateLine}><Text style={styles.heading}>조건을 채우면 추천이 정확해져요</Text>
        <Text style={styles.muted}>완성도 {completeness(visible.company, settings.supportPurpose)}%</Text></View>
        <View accessibilityLabel={`기업 조건 완성도 ${completeness(visible.company, settings.supportPurpose)}%`} style={local.track}>
          <View style={[local.progress, { width: `${completeness(visible.company, settings.supportPurpose)}%` }]} /></View>
        <Button label={visible.company ? '기업 정보 채우기' : '기업 등록하기'} variant="secondary" onPress={onCompany} /></Card>
    </>)}
    {!settingsOnly && <Pressable accessibilityRole="button" accessibilityLabel="수신 설정" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
      <Card><View style={local.dateLine}><Text style={styles.heading}>수신 설정 · 이메일 {settings.enabled ? '켬' : '끔'} · 앱 알림 {push.settings?.enabled ? '켬' : '끔'}</Text>
        <Text style={styles.muted}>{expanded ? '▴' : '▾'}</Text></View></Card>
    </Pressable>}
    {settingsOnly && <DeadlineReminderSettings />}
    {settingsOnly && !visible.company && <Card><Text style={styles.body}>기업 정보를 등록하면 정기 리포트를 받을 수 있어요.</Text>
      <Button label="기업 등록하기" variant="secondary" onPress={onCompany} /></Card>}
    {(settingsOnly || expanded) && <Card>
      <DailyReportPushSettings hasCompany={Boolean(visible.company)} />
      <Text style={styles.muted}>수신 주소: {session?.account.email} · {settings.emailConfirmed ? '확인 완료' : '확인 필요'}</Text>
      {!settings.emailDeliveryAvailable && <Notice>현재 이메일 발송 설정이 준비되지 않았어요. 확인 메일과 정기 발송을 사용할 수 없어요.</Notice>}
      {!settings.schedulerEnabled && <Notice>정기 리포트 예약이 꺼져 있어요. 이미 예약된 메일은 처리될 수 있어요.</Notice>}
      {!settings.emailConfirmed && settings.emailDeliveryAvailable && <Button label="이메일 주소 확인 메일 보내기"
        variant="secondary" busy={busy === 'verify'} disabled={Boolean(busy)} onPress={() => void verifyEmail()} />}
      <Field label="지원 목적 (선택, 최대 100자)" value={purpose} onChangeText={setPurpose} maxLength={100}
        editable={!busy} placeholder="예: AI 제품 개발, 해외 전시회 참가" />
      <Pressable accessibilityRole="switch" accessibilityLabel="정기 이메일 수신"
        accessibilityState={{ checked: enabled, disabled: Boolean(busy) }} disabled={Boolean(busy)}
        onPress={() => { setEnabled(!enabled); setConsent(false) }} style={local.option}>
        <Text style={styles.body}>매일 {sendHourLabel(settings.sendHour)} 이후 정기 이메일 받기</Text>
        <Text style={local.check}>{enabled ? '●' : '○'}</Text>
      </Pressable>
      {enabled && <Pressable accessibilityRole="checkbox" accessibilityLabel="정기 이메일 수신 동의"
        accessibilityState={{ checked: consent, disabled: Boolean(busy) }} disabled={Boolean(busy)}
        onPress={() => setConsent(!consent)} style={local.option}>
        <Text style={local.check}>{consent ? '☑' : '□'}</Text>
        <Text style={[styles.body, { flex: 1 }]}>기업 맞춤 지원사업 리포트의 정기 이메일 수신에 동의합니다.</Text>
      </Pressable>}
      <Button label="수신 설정 저장" busy={busy === 'save'} disabled={!canSave} onPress={() => void saveSettings()} />
      <Text style={styles.muted}>주소 확인과 수신 동의는 별개예요. 메일 서버 접수는 받은 편지함 도착을 보장하지 않아요.</Text>
    </Card>}
    {notice && <Notice>{notice}</Notice>}
    {actionError && <Notice error>{actionError}</Notice>}
  </Page>
}

function ReportProgramCard({ item, saved, busy, onOpen, onSource, onToggle }: {
  item: DailyReportItem; saved: boolean | null; busy: boolean; onOpen(): void; onSource(): void; onToggle(): void
}) {
  const period = periodLabel(item.applicationPeriod)
  return <Card>
    <View style={local.meta}><StatusBadge label={period?.status ?? '접수 상태 미확인'}
      tone={period?.status === '접수 중' ? 'success' : period?.status === '접수 예정' ? 'info' : 'neutral'} />
      {period?.deadline && <Text style={styles.muted}>{period.deadline}</Text>}
      <Text style={local.score}>{item.relevanceScore === null ? '관련도 점수 없음' : `관련도 ${item.relevanceScore}`}</Text></View>
    <Text style={styles.heading}>{item.title}</Text>
    <Text style={styles.muted}>{item.applicationPeriod || '공고문에서 접수 기간을 확인해 주세요.'}</Text>
    {item.matchedReasons.length > 0 && <View style={local.quote}><StatusBadge
      label={item.eligibilityStatus === 'MATCH' ? '조건 확인' : '확인 필요'}
      tone={item.eligibilityStatus === 'MATCH' ? 'success' : 'warning'} />
      <Text style={styles.muted}>{item.matchedReasons.join(' · ')}</Text></View>}
    <View style={local.actions}>
      <Pressable accessibilityRole="link" accessibilityLabel={`${item.title} 공식 원문 보기`} onPress={onSource}>
        <Text style={styles.muted}>원문 보기 ↗</Text></Pressable>
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel={saved === null ? `${item.title} 저장 상태 확인 필요` : saved ? `${item.title} 관심 공고에서 빼기` : `${item.title} 관심 공고에 저장`}
        accessibilityState={{ disabled: busy || saved === null, ...(saved === null ? {} : { selected: saved }) }} disabled={busy || saved === null} onPress={onToggle} style={local.bookmark}>
        <AppIcon name="bookmark" color={saved === null ? colors.muted : colors.primary} selected={saved === true} size={20} /></Pressable>
      <Button label="상세 보기" size="small" variant="secondary" onPress={onOpen} />
    </View>
  </Card>
}

const local = StyleSheet.create({
  dateLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  dateTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  dateMeta: { color: colors.secondaryText, fontSize: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  score: { color: colors.primaryText, marginLeft: 'auto', fontSize: 12, fontWeight: '600' },
  quote: { backgroundColor: colors.background, borderRadius: 10, padding: 10, flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bookmark: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: colors.soft },
  track: { height: 8, backgroundColor: colors.track, borderRadius: 999, overflow: 'hidden' },
  progress: { height: '100%', backgroundColor: colors.primary, borderRadius: 999 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, gap: 8 },
  check: { color: colors.primary, fontSize: 22, fontWeight: '600' },
  reportNotice: { color: colors.secondaryText, fontSize: 13, lineHeight: 20, paddingHorizontal: 4 },
})
