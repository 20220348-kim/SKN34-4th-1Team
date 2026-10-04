import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useFocusEffect } from 'expo-router'
import { companyDtoSchema, toCompany } from '@govbiz/shared/data/models/CompanyDto'
import { catalogSourceLabels } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { partnerRoleLabels, type PartnerRecruitment } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { partnerProposalStatusLabels } from '@govbiz/shared/domain/entities/PartnerProposal'
import type { Company } from '@govbiz/shared/domain/entities/Company'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import type { SupportProgramStatus } from '@govbiz/shared/domain/entities/SupportProgram'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, apiRequest, programClient } from '../api/client'
import { closeRecruitment, getPartnerWebUrl, getRecruitment, partnerErrorMessage, sendProposal } from '../api/partners'
import { useAuth } from '../auth/session'
import { PartnerSheet } from '../components/PartnerSheet'
import { partnerFullDate, recruitmentDeadlineLabel, recruitmentDeadlineTone } from '../components/PartnerDates'
import { Button, Card, Notice, Page, StatusBadge, colors, styles } from '../ui'

type DetailState = { token: string | null; detail: PartnerRecruitment | null; loading: boolean; error: string | null }
const blank = (token: string | null): DetailState => ({ token, detail: null, loading: true, error: null })

export function RecruitmentDetailScreen({ id, onLogin, onCompany, onProgram, onInbox, onEdit }: {
  id: number; onLogin(): void; onCompany(): void; onProgram(identity: SupportProgramIdentity): void; onInbox(): void; onEdit(): void
}) {
  const { session, status, invalidateSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [state, setState] = useState<DetailState>(() => blank(token))
  const [revision, setRevision] = useState(0)
  const [proposalOpen, setProposalOpen] = useState(false)
  const [company, setCompany] = useState<Company | null>(null)
  const [companyLoading, setCompanyLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [shareProfile, setShareProfile] = useState(true)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [linkedStatus, setLinkedStatus] = useState<{ key: string; status: SupportProgramStatus | null; error: boolean } | null>(null)
  const request = useRef<AbortController | null>(null)
  const insets = useSafeAreaInsets()

  useFocusEffect(useCallback(() => {
    const controller = new AbortController()
    setActionError(null); setProposalOpen(false); setCompany(null); setMessage('')
    setState((current) => current.token === token && current.detail ? { ...current, loading: false } : blank(token))
    void getRecruitment(id, token ?? undefined, controller.signal).then((detail) => {
      if (controller.signal.aborted) return
      setState({ token, detail, loading: false, error: null })
      const key = `${detail.program.sourceCode}:${detail.program.sourceProgramId}`
      setLinkedStatus({ key, status: null, error: false })
      void programClient(token ?? undefined).getDetail({ sourceCode: detail.program.sourceCode,
        sourceProgramId: detail.program.sourceProgramId }, controller.signal).then((program) => {
        if (!controller.signal.aborted) setLinkedStatus({ key, status: program?.status ?? null, error: !program })
      }).catch(() => {
        if (!controller.signal.aborted) setLinkedStatus({ key, status: null, error: true })
      })
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setState((current) => current.token === token && current.detail
        ? { ...current, error: partnerErrorMessage(cause), loading: false }
        : { ...blank(token), loading: false, error: partnerErrorMessage(cause) })
    })
    return () => { controller.abort(); request.current?.abort() }
  }, [id, token, revision, invalidateSession]))

  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(null), 8_000)
    return () => clearTimeout(timeout)
  }, [toast])

  async function openProposal() {
    if (!token) { onLogin(); return }
    if (session?.account.company?.businessStatusCode !== '01') { onCompany(); return }
    setProposalOpen(true); setActionError(null); setCompanyLoading(true); setCompany(null)
    const controller = new AbortController(); request.current = controller
    try {
      const result = toCompany(companyDtoSchema.parse(await apiRequest('/api/v1/me/company', { accessToken: token, signal: controller.signal })))
      if (!controller.signal.aborted) setCompany(result)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setActionError(partnerErrorMessage(cause))
    } finally { if (request.current === controller) setCompanyLoading(false) }
  }

  function closeProposal() {
    if (busy) return
    if (!message.trim()) { setProposalOpen(false); return }
    Alert.alert('작성 중인 제안을 닫을까요?', '이 화면을 떠나면 입력한 메시지가 사라질 수 있습니다.', [
      { text: '계속 작성', style: 'cancel' }, { text: '닫기', onPress: () => setProposalOpen(false) },
    ])
  }

  async function submitProposal() {
    const value = message.trim()
    if (!token || !company || !value || busy || !state.detail || state.detail.status !== 'OPEN') return
    const controller = new AbortController(); request.current = controller
    setBusy(true); setActionError(null)
    try {
      const proposal = await sendProposal(id, { message: value, shareProfile }, token, controller.signal)
      if (controller.signal.aborted) return
      setState((current) => current.token === token && current.detail
        ? { ...current, detail: { ...current.detail, myProposal: { id: proposal.id, status: proposal.status }, proposalCount: current.detail.proposalCount + 1 } } : current)
      setProposalOpen(false); setMessage(''); setToast('제안을 보냈어요')
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setActionError(partnerErrorMessage(cause))
    } finally { if (request.current === controller) setBusy(false) }
  }

  async function copyLink() {
    try {
      await Clipboard.setStringAsync(getPartnerWebUrl('/partners/detail', id))
      setToast('모집글 링크를 복사했어요')
    } catch (cause) { setActionError(partnerErrorMessage(cause)) }
  }

  function confirmClose() {
    if (!token || busy) return
    Alert.alert('모집을 마감할까요?', '마감 후 대기 중인 제안도 종료됩니다.', [
      { text: '취소', style: 'cancel' },
      { text: '모집 마감', style: 'destructive', onPress: () => void (async () => {
        const controller = new AbortController(); request.current = controller
        setBusy(true); setActionError(null)
        try {
          const detail = await closeRecruitment(id, token, controller.signal)
          if (!controller.signal.aborted) setState({ token, detail, loading: false, error: null })
        } catch (cause) {
          if (controller.signal.aborted) return
          if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
          setActionError(partnerErrorMessage(cause))
        } finally { if (request.current === controller) setBusy(false) }
      })() },
    ])
  }

  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice></Page>
  const visible = state.token === token ? state : blank(token)
  if (visible.loading && !visible.detail) return <Page><ActivityIndicator accessibilityLabel="모집글 상세 불러오는 중" color={colors.primary} /></Page>
  if (visible.error && !visible.detail) return <Page><Notice error>{visible.error}</Notice><Button label="다시 시도" onPress={() => setRevision((value) => value + 1)} /></Page>
  const detail = visible.detail
  if (!detail) return <Page><Notice error>모집글을 확인하지 못했습니다.</Notice></Page>
  const sourceName = catalogSourceLabels[detail.program.sourceCode as keyof typeof catalogSourceLabels] ?? detail.program.sourceCode
  const programStatus = linkedStatus?.key === `${detail.program.sourceCode}:${detail.program.sourceProgramId}` ? linkedStatus : null
  const programStatusLabels: Record<SupportProgramStatus, string> = {
    OPEN: '접수 중', UPCOMING: '접수 예정', CLOSED: '접수 마감', UNKNOWN: '접수 상태 미확인',
  }
  const programStatusColor = programStatus?.status === 'OPEN' ? colors.primary
    : programStatus?.status === 'UPCOMING' ? colors.info : colors.muted

  return <View style={local.page}>
    <Page>
      <View style={local.row}><StatusBadge label={`${sourceName} 공고`} tone="info" />
        <StatusBadge label={recruitmentDeadlineLabel(detail.recruitmentDeadline)}
          tone={recruitmentDeadlineTone(detail.recruitmentDeadline)} /></View>
      <Text style={styles.title}>{detail.title}</Text>
      <View style={local.author}><Text style={local.avatar}>{detail.company.companyName.slice(0, 1)}</Text>
        <View><Text style={styles.body}>{detail.company.companyName}</Text><Text style={styles.muted}>{detail.company.region} · {detail.company.industry}</Text></View></View>
      <View style={local.facts}><Fact label="찾는 역할" value={`${partnerRoleLabels[detail.seekingRole]} ${detail.seekingCount}곳`} />
        <Fact label="지역" value={detail.region} />
        <Fact label="필요 역량" value={detail.capabilities.join(' · ') || '제한 없음'} />
        <Fact label="모집 마감" value={partnerFullDate(detail.recruitmentDeadline)} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel={`연결된 공고 ${detail.program.title} 상세 보기`}
        onPress={() => onProgram({ sourceCode: detail.program.sourceCode, sourceProgramId: detail.program.sourceProgramId })}>
        <Card><Text style={styles.muted}>연결된 공고</Text><View style={local.row}><Text style={[styles.heading, { flex: 1 }]}>{detail.program.title}</Text>
          <Text style={styles.muted}>›</Text></View>
          <View style={local.programMeta}><View style={[local.statusDot, { backgroundColor: programStatusColor }]} />
            <Text style={[styles.muted, { color: programStatusColor }]}>{programStatus?.status
              ? programStatusLabels[programStatus.status] : programStatus?.error ? '접수 상태 조회 실패' : '접수 상태 확인 중'}</Text>
            {detail.program.applicationEndDate && <Text style={styles.muted}>접수 마감일 {partnerFullDate(detail.program.applicationEndDate)}</Text>}
          </View></Card>
      </Pressable>
      <Text style={styles.heading}>협업 소개</Text><Text style={styles.body}>{detail.body}</Text>
      {detail.isMine && detail.status === 'OPEN' && <View style={local.row}>
        <Button label="수정" variant="secondary" onPress={onEdit} />
        <Button label="모집 마감" variant="danger" disabled={busy} onPress={confirmClose} /></View>}
      {detail.myProposal && <Notice>보낸 제안: {partnerProposalStatusLabels[detail.myProposal.status]}</Notice>}
      {visible.error && <Notice error>{visible.error}</Notice>}
      {actionError && !proposalOpen && <Notice error>{actionError}</Notice>}
    </Page>
    <View style={[local.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}><Button label="링크 복사" variant="secondary" onPress={() => void copyLink()} />
      {detail.isMine ? <Button label="내 모집글" variant="secondary" disabled onPress={() => undefined} />
        : detail.myProposal ? <Button label="제안함 보기" onPress={onInbox} />
          : detail.status !== 'OPEN' ? <Button label="모집 마감" disabled onPress={() => undefined} />
            : session?.account.company?.businessStatusCode === '01'
              ? <Button label="제안 보내기" onPress={() => void openProposal()} />
              : <Button label={token ? '기업 등록 후 제안하기' : '로그인하고 제안하기'} onPress={token ? onCompany : onLogin} />}</View>
    {toast && <View accessibilityLiveRegion="polite" style={local.toast}><Text style={local.toastText}>{toast}</Text>
      {toast === '제안을 보냈어요' && <Button label="제안함 보기" variant="ghost" onPress={onInbox} />}</View>}
    <PartnerSheet visible={proposalOpen} title="제안 보내기" onClose={closeProposal}
      actions={<><Button label="취소" variant="secondary" disabled={busy} onPress={closeProposal} />
        <Button label="보내기" disabled={busy || !message.trim() || !company} busy={busy} onPress={() => void submitProposal()} /></>}>
      <View style={local.author}><Text style={local.avatar}>{detail.company.companyName.slice(0, 1)}</Text>
        <View><Text style={styles.heading}>{detail.company.companyName}</Text><Text style={styles.muted}>{detail.title}</Text></View></View>
      <Card><Text style={styles.heading}>모집 조건</Text><Fact label="찾는 역할" value={`${partnerRoleLabels[detail.seekingRole]} ${detail.seekingCount}곳`} />
        <Fact label="지역" value={detail.region} /><Fact label="필요 역량" value={detail.capabilities.join(' · ') || '제한 없음'} /></Card>
      <Text style={styles.label}>제안 메시지 *</Text>
      <TextInput accessibilityLabel="제안 메시지" placeholder="우리 기업이 맡을 수 있는 일과 비슷한 경험을 적어 주세요"
        placeholderTextColor={colors.placeholder} value={message} onChangeText={setMessage} maxLength={500}
        multiline textAlignVertical="top" editable={!busy} style={local.input} />
      <Text style={styles.muted}>{message.length} / 500자</Text>
      <Pressable accessibilityRole="checkbox" accessibilityLabel="기업 정보 함께 보이기"
        accessibilityState={{ checked: shareProfile }} onPress={() => setShareProfile(!shareProfile)} style={local.row}>
        <Text style={local.check}>{shareProfile ? '☑' : '□'}</Text>
        <View style={{ flex: 1 }}><Text style={styles.body}>기업 정보 함께 보이기</Text>
          <Text style={styles.muted}>{company
            ? `${company.companyName} · ${company.region} · ${company.industry} · ${company.foundedYear}년 설립 정보를 함께 보내요`
            : '기업 정보를 확인 중입니다.'}</Text></View></Pressable>
      <Text style={styles.muted}>연락처는 제안 수락 후 공개돼요.</Text>
      {companyLoading && <ActivityIndicator accessibilityLabel="기업 정보 확인 중" color={colors.primary} />}
      {actionError && <Notice error>{actionError}</Notice>}
    </PartnerSheet>
  </View>
}

function Fact({ label, value }: { label: string; value: string }) {
  return <View style={local.fact}><Text style={styles.muted}>{label}</Text><Text style={[styles.body, { flex: 1, textAlign: 'right' }]}>{value}</Text></View>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.surface },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  author: { backgroundColor: colors.background, borderRadius: 10, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.soft, color: colors.primary,
    textAlign: 'center', textAlignVertical: 'center', lineHeight: 34, overflow: 'hidden' },
  facts: { gap: 2 },
  fact: { minHeight: 45, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  footer: { backgroundColor: colors.surface, padding: 12, flexDirection: 'row', gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  programMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  input: { minHeight: 160, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 12,
    padding: 12, fontSize: 16, lineHeight: 24, color: colors.text },
  check: { color: colors.primary, fontSize: 22 },
  toast: { position: 'absolute', bottom: 90, left: 12, right: 12, borderRadius: 12, backgroundColor: colors.text,
    padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toastText: { color: colors.surface, fontSize: 14 },
})
