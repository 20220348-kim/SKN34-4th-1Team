import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect, useNavigation } from 'expo-router'
import { usePreventRemove } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { companyAgeYearsRange, ownPartnerRoles, partnerRoleLabels, recruitmentBodyMaxLength,
  recruitmentCapabilityMaxCount, recruitmentCapabilityMaxLength, recruitmentTitleMaxLength, seekingCountRange,
  seekingPartnerRoles, type PartnerRecruitment, type PartnerRecruitmentContentInput, type PartnerRecruitmentInput, type PartnerRole } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { catalogSourceLabels } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { regionNamesNationwideFirst } from '@govbiz/shared/domain/entities/Region'
import type { SupportProgram } from '@govbiz/shared/domain/entities/SupportProgram'
import { validatePartnerRecruitmentContent } from '@govbiz/shared/domain/usecases/PartnerRecruitmentUseCases'
import { ApiError } from '../api/client'
import { createRecruitment, getRecruitment, partnerErrorMessage, updateRecruitment } from '../api/partners'
import { listSavedPrograms } from '../api/savedPrograms'
import { useAuth } from '../auth/session'
import { ChoiceField } from '../components/ChoiceField'
import { PartnerSheet } from '../components/PartnerSheet'
import { partnerDeadlineDay, partnerFullDate } from '../components/PartnerDates'
import { Button, Card, Field, Notice, Page, StatusBadge, colors, styles } from '../ui'

type Props = { recruitmentId?: number; onLogin(): void; onCompany(): void; onSavedPrograms(): void; onCreated(id: number): void; onCancel(): void }
const seoulToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
const latestDeadline = (program: Pick<SupportProgram, 'applicationEndDate'> | null) => program?.applicationEndDate
  ? new Date(Date.parse(`${program.applicationEndDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : null
function programBlocker(program: SupportProgram) {
  if (program.status !== 'OPEN') return '접수 중 아님'
  const latest = latestDeadline(program)
  return latest !== null && latest < seoulToday() ? '오늘 접수 마감' : null
}
const fieldMessages: Record<string, string> = {
  program: '관심 공고함에서 연결할 공고를 선택해 주세요.',
  title: `제목을 1~${recruitmentTitleMaxLength}자로 입력해 주세요.`,
  body: `협업 소개를 1~${recruitmentBodyMaxLength}자로 입력해 주세요.`,
  seekingCount: `찾는 기업 수는 ${seekingCountRange.min}~${seekingCountRange.max}곳으로 입력해 주세요.`,
  minimumCompanyAgeYears: `희망 업력은 ${companyAgeYearsRange.min}~${companyAgeYearsRange.max}년의 정수로 입력하거나 비워 두세요.`,
  capabilities: `필요 역량은 ${recruitmentCapabilityMaxLength}자 이내로 ${recruitmentCapabilityMaxCount}개까지 입력할 수 있어요.`,
  recruitmentDeadline: '모집 마감일을 선택해 주세요.',
}

/** 작성과 수정은 같은 네이티브 입력 폼을 사용하며, 수정에서는 연결된 공고를 고정한다. */
export function RecruitmentCreateScreen(props: Props) {
  const { status, session } = useAuth()
  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice></Page>
  if (status !== 'signedIn' || !session) return <Page><Notice>{props.recruitmentId === undefined ? '로그인하고 기업을 등록한 뒤 모집글을 작성할 수 있어요.' : '로그인하고 기업 정보를 확인한 뒤 내 모집글을 수정할 수 있어요.'}</Notice>
    <Button label="로그인하기" onPress={props.onLogin} /></Page>
  if (session.account.company?.businessStatusCode !== '01') return <Page>
    <Notice>{props.recruitmentId === undefined ? '모집글 작성은 등록된 계속사업자만 할 수 있어요. 기업 정보를 확인해 주세요.' : '모집글 수정은 등록된 계속사업자만 할 수 있어요. 기업 정보를 확인해 주세요.'}</Notice>
    <Button label="기업 정보 확인" onPress={props.onCompany} /></Page>
  return <OwnedCreate key={`${session.accessToken}:${props.recruitmentId ?? 'new'}`} token={session.accessToken}
    companyName={session.account.company.companyName} {...props} />
}

function OwnedCreate({ token, companyName, recruitmentId, onCreated, onCancel, onSavedPrograms, onCompany }: Props & { token: string; companyName: string }) {
  const { invalidateSession } = useAuth()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  const [program, setProgram] = useState<SupportProgram | null>(null)
  const [editingRecruitment, setEditingRecruitment] = useState<PartnerRecruitment | null>(null)
  const [editLoading, setEditLoading] = useState(recruitmentId !== undefined)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBlock, setEditBlock] = useState<string | null>(null)
  const [editRevision, setEditRevision] = useState(0)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const originalInputs = useRef('')
  const [ownRole, setOwnRole] = useState<PartnerRole>('LEAD')
  const [seekingRole, setSeekingRole] = useState<PartnerRole>('PARTICIPANT')
  const [count, setCount] = useState(1)
  const [region, setRegion] = useState('전국')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [capabilityDraft, setCapabilityDraft] = useState('')
  const [deadline, setDeadline] = useState('')
  const [age, setAge] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [companyRequired, setCompanyRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [programs, setPrograms] = useState<SupportProgram[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const request = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const exitApproved = useRef(false)
  const editing = recruitmentId !== undefined
  const programInfo = editingRecruitment ? { ...editingRecruitment.program,
    sourceName: catalogSourceLabels[editingRecruitment.program.sourceCode as keyof typeof catalogSourceLabels] ?? editingRecruitment.program.sourceCode } : program
  const maximumDeadline = latestDeadline(programInfo)
  const dirty = editing ? editingRecruitment !== null && originalInputs.current !== JSON.stringify({ ownRole, seekingRole, count, region, capabilities, capabilityDraft, deadline, age, title, body })
    : Boolean(program || title || body || age || capabilityDraft || capabilities.length || deadline
      || ownRole !== 'LEAD' || seekingRole !== 'PARTICIPANT' || count !== 1 || region !== '전국')

  useEffect(() => {
    if (recruitmentId === undefined) return
    const controller = new AbortController()
    setEditLoading(true); setEditError(null); setEditBlock(null)
    void getRecruitment(recruitmentId, token, controller.signal).then(detail => {
      if (controller.signal.aborted) return
      if (detail.id !== recruitmentId) throw new Error('요청한 모집글과 응답이 다릅니다.')
      if (!detail.isMine) { setEditBlock('내가 쓴 모집글만 수정할 수 있어요.'); return }
      if (detail.status !== 'OPEN') { setEditBlock('마감된 모집글은 수정할 수 없어요.'); return }
      const savedAge = detail.minimumCompanyAgeYears === null ? '' : String(detail.minimumCompanyAgeYears)
      originalInputs.current = JSON.stringify({ ownRole: detail.ownRole, seekingRole: detail.seekingRole, count: detail.seekingCount,
        region: detail.region, capabilities: detail.capabilities, capabilityDraft: '', deadline: detail.recruitmentDeadline,
        age: savedAge, title: detail.title, body: detail.body })
      setOwnRole(detail.ownRole); setSeekingRole(detail.seekingRole); setCount(detail.seekingCount); setRegion(detail.region)
      setCapabilities(detail.capabilities); setCapabilityDraft(''); setDeadline(detail.recruitmentDeadline)
      setAge(savedAge); setTitle(detail.title); setBody(detail.body); setEditingRecruitment(detail)
    }).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setEditError(partnerErrorMessage(cause))
    }).finally(() => { if (!controller.signal.aborted) setEditLoading(false) })
    return () => controller.abort()
  }, [recruitmentId, token, editRevision, invalidateSession])

  function confirmExit(exit: () => void) {
    if (submitting.current) {
      Alert.alert(editing ? '모집글 저장을 확인 중이에요' : '모집글 등록을 확인 중이에요', '처리 결과를 확인한 뒤 이동해 주세요. 입력한 내용은 이 화면에 남아 있어요.')
      return
    }
    if (!dirty || exitApproved.current) { exit(); return }
    Alert.alert(editing ? '수정 중인 모집글을 나갈까요?' : '작성 중인 모집글을 나갈까요?', '저장하지 않은 내용은 사라질 수 있어요.', [
      { text: '계속 작성', style: 'cancel' },
      { text: '나가기', style: 'destructive', onPress: () => { exitApproved.current = true; exit() } },
    ])
  }
  usePreventRemove(dirty || busy, ({ data }) => confirmExit(() => navigation.dispatch(data.action)))

  useFocusEffect(useCallback(() => {
    exitApproved.current = false
    return () => { request.current?.abort() }
  }, []))
  useFocusEffect(useCallback(() => {
    if (!pickerOpen) return
    const controller = new AbortController()
    setPickerLoading(true); setPickerError(null); setPrograms([])
    void listSavedPrograms(token, controller.signal).then(items => {
      if (!controller.signal.aborted) setPrograms(items.map(item => item.program))
    }).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setPickerError(partnerErrorMessage(cause))
    }).finally(() => { if (!controller.signal.aborted) setPickerLoading(false) })
    return () => controller.abort()
  }, [pickerOpen, token, revision, invalidateSession]))

  function chooseProgram(next: SupportProgram) {
    const blocked = programBlocker(next)
    if (blocked) return
    setProgram(next); setPickerOpen(false); setError(null)
    const latest = latestDeadline(next)
    if (latest !== null && deadline > latest) setDeadline('')
  }
  function addCapability() {
    const value = capabilityDraft.trim()
    if (!value || busy) return
    if (value.length > recruitmentCapabilityMaxLength || capabilities.length >= recruitmentCapabilityMaxCount) {
      setError(fieldMessages.capabilities); return
    }
    if (!capabilities.includes(value)) setCapabilities(current => [...current, value])
    setCapabilityDraft(''); setError(null)
  }
  async function submit() {
    if (submitting.current || saveBlocked || editLoading) return
    if (editing && !editingRecruitment) return
    if (!editing && !program) { setError(fieldMessages.program); return }
    if (!editing && program && programBlocker(program)) { setError('선택한 공고는 모집글을 작성할 수 없어요. 다른 관심 공고를 선택해 주세요.'); return }
    const value = capabilityDraft.trim()
    const includedCapabilities = [...new Set([...capabilities, ...(value ? [value] : [])])]
    const content: PartnerRecruitmentContentInput = {
      ownRole, seekingRole, seekingCount: count, region, capabilities: includedCapabilities,
      minimumCompanyAgeYears: age.trim() ? Number(age) : null, recruitmentDeadline: deadline,
      title: title.trim(), body: body.trim() }
    const problem = validatePartnerRecruitmentContent(content)
    if (problem) { setError(fieldMessages[problem] ?? '입력한 모집 조건을 확인해 주세요.'); return }
    const day = partnerDeadlineDay(deadline)
    if (day === null || day < 0) { setError('모집 마감일을 오늘 이후의 날짜로 선택해 주세요.'); return }
    if (maximumDeadline !== null && deadline > maximumDeadline) {
      setError(`모집 마감일은 ${partnerFullDate(maximumDeadline)}까지 선택할 수 있어요.`); return
    }
    submitting.current = true; setBusy(true); setError(null); setCompanyRequired(false)
    const controller = new AbortController(); request.current = controller
    try {
      if (recruitmentId !== undefined && editingRecruitment) {
        const result = await updateRecruitment(recruitmentId, content, token, controller.signal)
        if (controller.signal.aborted) return
        switch (result.outcome) {
          case 'updated':
            if (result.recruitment.program.sourceCode !== editingRecruitment.program.sourceCode
              || result.recruitment.program.sourceProgramId !== editingRecruitment.program.sourceProgramId) throw new Error('수정한 모집글의 연결 공고가 다릅니다.')
            submitting.current = false; exitApproved.current = true; onCreated(result.recruitment.id); return
          case 'not-found': setSaveBlocked(true); setError('모집글을 더 이상 찾을 수 없어요. 입력은 유지되며 상세 화면에서 다시 확인해 주세요.'); return
          case 'forbidden': setSaveBlocked(true); setError('이 모집글을 수정할 권한이 없어요. 입력은 유지되며 상세 화면에서 다시 확인해 주세요.'); return
          case 'closed': setSaveBlocked(true); setError('모집이 마감되어 수정할 수 없어요. 입력은 이 화면에 남아 있어요.'); return
          case 'deadline-not-allowed': setError('모집 마감일이 허용되지 않아요. 공고 접수 마감 전날까지의 날짜인지 확인해 주세요.'); return
        }
      }
      const input: PartnerRecruitmentInput = { ...content, sourceCode: program!.sourceCode, sourceProgramId: program!.id }
      const result = await createRecruitment(input, token, controller.signal)
      if (controller.signal.aborted) return
      switch (result.outcome) {
        case 'created': submitting.current = false; exitApproved.current = true; onCreated(result.recruitment.id); return
        case 'company-required': setCompanyRequired(true); setError('등록된 계속사업자만 모집글을 작성할 수 있어요. 기업 정보를 다시 확인해 주세요.'); return
        case 'program-not-found': setError('선택한 공고를 더 이상 찾을 수 없어요. 관심 공고함에서 다시 선택해 주세요.'); return
        case 'program-closed': setError('선택한 공고의 접수가 마감됐어요. 다른 관심 공고를 선택해 주세요.'); return
        case 'deadline-not-allowed': setError('모집 마감일이 허용되지 않아요. 관심 공고함에서 최신 공고를 다시 선택하고 마감일을 확인해 주세요.'); return
        case 'already-exists': setError('이 공고에는 이미 내 모집글이 있어요. 공고당 모집글은 하나만 등록할 수 있어요.'); return
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      if (cause instanceof ApiError && (cause.code === 'COMPANY_REQUIRED' || cause.code === 'ACTIVE_BUSINESS_REQUIRED')) setCompanyRequired(true)
      setError(partnerErrorMessage(cause))
    } finally {
      if (request.current === controller) { submitting.current = false; setBusy(false); request.current = null }
    }
  }

  if (editing && editLoading) return <Page><ActivityIndicator accessibilityLabel="수정할 모집글 불러오는 중" color={colors.primary} /></Page>
  if (editing && (editError || editBlock || !editingRecruitment)) return <Page>
    <Notice error>{editError ?? editBlock ?? '수정할 모집글을 확인하지 못했어요.'}</Notice>
    {editError && <Button label="모집글 다시 불러오기" onPress={() => setEditRevision(current => current + 1)} />}
    <Button label="모집글 상세로 돌아가기" variant="secondary" onPress={onCancel} />
  </Page>

  return <View style={local.page}>
    <Page>
      <Text style={styles.subtitle}>{editing ? '연결된 공고를 유지하고 모집 조건과 소개를 수정해요.' : '함께 지원사업을 준비할 기업을 모집해요.'}</Text>
      <Card><Text style={styles.heading}>1. 연결할 공고</Text>
        <Text style={styles.muted}>작성 기업: {editingRecruitment?.company.companyName ?? companyName}</Text>
        {programInfo ? <View style={{ gap: 8 }}><View style={styles.row}><StatusBadge label={programInfo.sourceName} />
          <Text style={styles.muted}>{programInfo.applicationEndDate ? `공고 마감 ${partnerFullDate(programInfo.applicationEndDate)}` : '공고 마감일 미정'}</Text></View>
          <Text style={styles.heading}>{programInfo.title}</Text><Text style={styles.muted}>{programInfo.organization}</Text>
          {!editing && <Button label="공고 변경" variant="secondary" disabled={busy} onPress={() => setPickerOpen(true)} />}</View>
          : <Button label="관심 공고함에서 선택" variant="secondary" disabled={busy} onPress={() => setPickerOpen(true)} />}
        <Text style={styles.muted}>{editing ? '수정할 때 연결된 공고는 바꿀 수 없어요.' : '관심 공고함에 담은 접수 중 공고 한 개를 선택해 주세요.'}</Text>
      </Card>
      <Card><Text style={styles.heading}>2. 역할과 조건</Text>
        <Text style={local.label}>우리 기업의 역할</Text>
        <RoleChoices label="우리 역할" roles={ownPartnerRoles} value={ownRole} onChange={setOwnRole} disabled={busy} />
        <Text style={local.label}>찾는 역할</Text>
        <RoleChoices label="찾는 역할" roles={seekingPartnerRoles} value={seekingRole} onChange={setSeekingRole} disabled={busy} />
        <View style={local.countRow}><Text style={styles.label}>찾는 기업 수</Text><View style={local.stepper}>
          <Button label="−" accessibilityLabel="찾는 기업 수 줄이기" variant="secondary" disabled={busy || count <= seekingCountRange.min} onPress={() => setCount(current => Math.max(seekingCountRange.min, current - 1))} />
          <Text style={styles.body}>{count}곳</Text>
          <Button label="+" accessibilityLabel="찾는 기업 수 늘리기" variant="secondary" disabled={busy || count >= seekingCountRange.max} onPress={() => setCount(current => Math.min(seekingCountRange.max, current + 1))} /></View></View>
        <ChoiceField label="희망 지역" value={region} disabled={busy} options={regionNamesNationwideFirst.map(value => ({ value, label: value }))} onChange={setRegion} />
        {programInfo?.targetDescription ? <Text style={styles.muted}>공고 지원대상: {programInfo.targetDescription}</Text> : null}
        <Text style={local.label}>필요 역량 <Text style={styles.muted}>선택 · 최대 {recruitmentCapabilityMaxCount}개</Text></Text>
        <View style={local.chips}>{capabilities.map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={`${value} 삭제`}
          disabled={busy} onPress={() => setCapabilities(current => current.filter(item => item !== value))} style={local.chip}>
          <Text style={local.chipText}>{value} ×</Text></Pressable>)}</View>
        <View style={local.capabilityEntry}><TextInput accessibilityLabel="필요 역량 입력" value={capabilityDraft} onChangeText={setCapabilityDraft}
          maxLength={recruitmentCapabilityMaxLength} placeholder="역량 입력 후 추가" placeholderTextColor={colors.placeholder}
          editable={!busy} onSubmitEditing={addCapability} style={[styles.input, { flex: 1 }]} />
          <Button label="추가" variant="secondary" disabled={busy || !capabilityDraft.trim()} onPress={addCapability} /></View>
        <Text style={local.label}>모집 마감일 *</Text>
        <Button label={deadline ? partnerFullDate(deadline) : '모집 마감일 선택'} accessibilityLabel="모집 마감일 선택"
          variant="secondary" disabled={busy || !programInfo} onPress={() => setCalendarOpen(true)} />
        <Text style={styles.muted}>{maximumDeadline ? `${partnerFullDate(maximumDeadline)}까지 선택할 수 있어요.` : '오늘 이후 날짜를 선택해 주세요.'}
          {'\n'}공고가 먼저 마감되면 모집도 자동 종료돼요.</Text>
        <Field label="희망 최소 업력 (선택)" value={age} onChangeText={setAge} editable={!busy} keyboardType="number-pad"
          placeholder="무관 (1~50년 입력 가능)" maxLength={2} />
      </Card>
      <Card><Text style={styles.heading}>3. 협업 소개</Text>
        <Field label="모집글 제목 *" value={title} onChangeText={setTitle} editable={!busy} maxLength={recruitmentTitleMaxLength}
          placeholder="어떤 과제에 어떤 파트너를 찾는지 알려 주세요" />
        <Text style={local.counter}>{title.length} / {recruitmentTitleMaxLength}</Text>
        <Field label="협업 소개 *" value={body} onChangeText={setBody} editable={!busy} maxLength={recruitmentBodyMaxLength}
          multiline textAlignVertical="top" style={[styles.input, local.bodyInput]}
          placeholder={'우리 기업 소개\n우리가 맡을 일\n함께할 기업에게 바라는 역량\n예상 일정'} />
        <Text style={local.counter}>{body.length} / {recruitmentBodyMaxLength}</Text>
        <Text style={styles.muted}>우리 기업이 맡을 일과 상대에게 바라는 일을 나눠 적어 주세요.</Text>
      </Card>
      <Text style={styles.muted}>기업명과 모집 조건은 공개되며, 담당자 연락처는 제안 수락 후 공유돼요.</Text>
    </Page>
    <View style={[local.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {error && <Notice error>{error}</Notice>}
      {companyRequired && <Button label="기업 정보 확인" variant="secondary" onPress={onCompany} />}
      {saveBlocked && <Button label="모집글 상세 다시 확인" variant="secondary" onPress={() => confirmExit(onCancel)} />}
      <View style={local.footerButtons}><Button label="취소" variant="secondary" disabled={busy} onPress={() => confirmExit(onCancel)} />
        <Button label={editing ? '수정 내용 저장' : '모집글 등록'} busy={busy} disabled={busy || saveBlocked || editing && !dirty} style={{ flex: 1 }} onPress={() => void submit()} /></View>
    </View>
    <PartnerSheet visible={pickerOpen} title="관심 공고 선택" onClose={() => setPickerOpen(false)}
      actions={<Button label="닫기" variant="secondary" onPress={() => setPickerOpen(false)} />}>
      {pickerLoading ? <ActivityIndicator accessibilityLabel="관심 공고 불러오는 중" color={colors.primary} />
        : pickerError ? <><Notice error>{pickerError}</Notice><Button label="관심 공고 다시 불러오기" onPress={() => setRevision(current => current + 1)} /></>
          : programs.length === 0 ? <><Notice>관심 공고함에 담은 공고가 없어요. 먼저 공고를 담아 주세요.</Notice>
            <Button label="관심 공고함으로" onPress={() => { setPickerOpen(false); onSavedPrograms() }} /></>
            : programs.map(item => { const blocker = programBlocker(item)
              const selected = program?.sourceCode === item.sourceCode && program.id === item.id
              return <Pressable key={`${item.sourceCode}:${item.id}`} accessibilityRole="button" accessibilityLabel={`공고 선택: ${item.sourceName} ${item.title}`}
                accessibilityState={{ disabled: Boolean(blocker), selected }} disabled={Boolean(blocker)} onPress={() => chooseProgram(item)}
                style={[local.programChoice, selected && local.selected, blocker && { opacity: 0.6 }]}>
                <View style={styles.row}><StatusBadge label={item.sourceName} /><Text style={styles.muted}>{blocker ?? (selected ? '선택됨' : '접수 중')}</Text></View>
                <Text style={styles.heading}>{item.title}</Text><Text style={styles.muted}>{item.organization}</Text>
                <Text style={styles.muted}>{item.applicationEndDate ? `접수 마감 ${partnerFullDate(item.applicationEndDate)}` : '접수 마감일 미정'}</Text>
              </Pressable>
            })}
    </PartnerSheet>
    <RecruitmentCalendar visible={calendarOpen} value={deadline} maximum={maximumDeadline}
      onClose={() => setCalendarOpen(false)} onSelect={value => { setDeadline(value); setCalendarOpen(false); setError(null) }} />
  </View>
}

function RoleChoices({ label, roles, value, onChange, disabled }: {
  label: string; roles: readonly PartnerRole[]; value: PartnerRole; onChange(value: PartnerRole): void; disabled: boolean
}) {
  return <View style={local.roleRow}>{roles.map(role => <Pressable key={role} accessibilityRole="radio"
    accessibilityLabel={`${label} ${partnerRoleLabels[role]}`} accessibilityState={{ checked: value === role, disabled }}
    disabled={disabled} onPress={() => onChange(role)} style={[local.role, value === role && local.selected]}>
    <Text style={[styles.body, value === role && { color: colors.primaryText, fontWeight: '600' }]}>{partnerRoleLabels[role]}</Text>
  </Pressable>)}</View>
}

/** Calendar inputs use the same Seoul dates and inclusive minimum as the existing server contract. */
function RecruitmentCalendar({ visible, value, maximum, onSelect, onClose }: {
  visible: boolean; value: string; maximum: string | null; onSelect(value: string): void; onClose(): void
}) {
  const today = seoulToday()
  const [month, setMonth] = useState(today.slice(0, 7))
  useEffect(() => { if (visible) setMonth((value >= today && (!maximum || value <= maximum) ? value : today).slice(0, 7)) }, [visible, value, today, maximum])
  const [year, monthNumber] = month.split('-').map(Number)
  const offset = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  function shift(amount: number) { setMonth(new Date(Date.UTC(year, monthNumber - 1 + amount, 1)).toISOString().slice(0, 7)) }
  return <PartnerSheet visible={visible} title="모집 마감일" onClose={onClose}
    actions={<Button label="닫기" variant="secondary" onPress={onClose} />}>
    <Text style={styles.muted}>{maximum ? `${partnerFullDate(today)} ~ ${partnerFullDate(maximum)}` : `${partnerFullDate(today)} 이후`}</Text>
    <View style={local.monthRow}><Button label="‹" accessibilityLabel="이전 달" variant="ghost" disabled={month <= today.slice(0, 7)} onPress={() => shift(-1)} />
      <Text style={styles.heading}>{year}년 {monthNumber}월</Text>
      <Button label="›" accessibilityLabel="다음 달" variant="ghost" disabled={maximum !== null && month >= maximum.slice(0, 7)} onPress={() => shift(1)} /></View>
    <View style={local.calendarGrid}>{['일', '월', '화', '수', '목', '금', '토'].map(day => <View key={day} style={local.dayCell}><Text style={styles.muted}>{day}</Text></View>)}
      {Array.from({ length: offset }, (_, i) => <View key={`blank-${i}`} style={local.dayCell} />)}
      {Array.from({ length: days }, (_, i) => { const date = `${month}-${String(i + 1).padStart(2, '0')}`
        const disabled = date < today || maximum !== null && date > maximum
        return <Pressable key={date} accessibilityRole="button" accessibilityLabel={`마감일 ${date}`}
          accessibilityState={{ disabled, selected: date === value }} disabled={disabled} onPress={() => onSelect(date)}
          style={[local.dayCell, date === value && local.selected, disabled && { opacity: 0.3 }]}><Text style={styles.body}>{i + 1}</Text></Pressable>
      })}
    </View>
  </PartnerSheet>
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  label: { ...styles.label, marginTop: 10 },
  roleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  role: { minWidth: 88, minHeight: 48, flex: 1, borderRadius: 12, borderWidth: 1, borderColor: colors.fieldBorder,
    alignItems: 'center', justifyContent: 'center', padding: 10 },
  selected: { backgroundColor: colors.soft, borderColor: colors.primary },
  countRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginVertical: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 99, padding: 10, minHeight: 44, justifyContent: 'center', backgroundColor: colors.soft },
  chipText: { fontSize: 14, color: colors.primaryText },
  capabilityEntry: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  bodyInput: { minHeight: 180, lineHeight: 24 },
  counter: { ...styles.muted, textAlign: 'right' },
  footer: { padding: 12, gap: 8, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  footerButtons: { flexDirection: 'row', gap: 8 },
  programChoice: { padding: 14, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 12, gap: 8 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: `${100 / 7}%`, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
})
