import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native'
import { type CompanyPartnerProfile, type CompanyPartnerProfileInput, type CompanyPartnerProfileField,
  companyPartnerProfileLimits as limits, emptyCompanyPartnerProfile, findCompanyPartnerProfileProblem } from '@govbiz/shared/domain/entities/CompanyPartnerProfile'
import { ownPartnerRoles, partnerRoleLabels, type PartnerRole } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { supportProgramCategories } from '@govbiz/shared/domain/entities/SupportProgramCategory'
import { getCompanyPartnerProfile, saveCompanyPartnerProfile } from '../api/company'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/session'
import { Button, Card, Field, Notice, StatusBadge, colors, styles } from '../ui'
import { PartnerSheet } from './PartnerSheet'

const messages: Record<CompanyPartnerProfileField, string> = {
  roles: '참여 가능 역할을 하나 이상 골라 주세요.',
  interestAreas: `관심 분야는 ${limits.interestAreaMaxCount}개까지 고를 수 있습니다.`,
  introduction: `한 줄 소개는 ${limits.introductionMaxLength}자 이하로 입력해 주세요.`,
  capabilities: `보유 역량은 ${limits.capabilityMaxLength}자 이내로 ${limits.capabilityMaxCount}개까지 넣을 수 있습니다.`,
}

function toForm(profile: CompanyPartnerProfile): CompanyPartnerProfileInput {
  return { roles: [...profile.roles], interestAreas: [...profile.interestAreas], introduction: profile.introduction, capabilities: [...profile.capabilities] }
}

/** Mounted for a registered company and keyed by its owner; this section owns only partner-profile editing. */
export function CompanyPartnerProfileSection({ token, onRefreshCompany, disabled = false }: { token: string; onRefreshCompany(): void; disabled?: boolean }) {
  const { invalidateSession } = useAuth()
  const [profile, setProfile] = useState<CompanyPartnerProfile | null>(null)
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'failed' | 'company-required'>('loading')
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(() => toForm(emptyCompanyPartnerProfile))
  const [capabilityDraft, setCapabilityDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const editVersion = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoadStatus('loading'); setProfile(null); setNotice(null)
    void getCompanyPartnerProfile(token, controller.signal).then(saved => {
      if (controller.signal.aborted) return
      if (saved === null) { setLoadStatus('company-required'); return }
      setProfile(saved); setForm(toForm(saved)); setLoadStatus('ready')
    }).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setLoadStatus('failed')
    })
    return () => { controller.abort(); mutation.current?.abort(); editVersion.current += 1 }
  }, [token, revision, invalidateSession])

  function startEditing() {
    if (!profile || saving || disabled) return
    editVersion.current += 1
    setForm(toForm(profile)); setCapabilityDraft(''); setError(null); setNotice(null); setEditing(true)
  }
  function cancelEditing() {
    if (mutation.current) return
    editVersion.current += 1
    if (profile) setForm(toForm(profile))
    setCapabilityDraft(''); setError(null); setEditing(false)
  }
  function closeEditing() {
    if (mutation.current) return
    const dirty = profile && (JSON.stringify(toForm(profile)) !== JSON.stringify(form) || capabilityDraft.trim() !== '')
    if (!dirty) { cancelEditing(); return }
    const version = editVersion.current
    Alert.alert('수정한 협업 설정을 취소할까요?', '저장하지 않은 변경은 사라집니다.', [
      { text: '계속 수정', style: 'cancel' },
      { text: '변경 취소', style: 'destructive', onPress: () => { if (editVersion.current === version) cancelEditing() } },
    ])
  }
  function toggleRole(role: PartnerRole) {
    setForm(current => ({ ...current, roles: current.roles.includes(role) ? current.roles.filter(value => value !== role) : [...current.roles, role] }))
    setError(null)
  }
  function toggleInterestArea(area: string) {
    if (!form.interestAreas.includes(area) && form.interestAreas.length >= limits.interestAreaMaxCount) { setError(messages.interestAreas); return }
    setForm(current => ({ ...current, interestAreas: current.interestAreas.includes(area) ? current.interestAreas.filter(value => value !== area) : [...current.interestAreas, area] }))
    setError(null)
  }
  function addCapability() {
    const value = capabilityDraft.trim()
    if (!value || form.capabilities.includes(value)) { setCapabilityDraft(''); return }
    if (value.length > limits.capabilityMaxLength || form.capabilities.length >= limits.capabilityMaxCount) { setError(messages.capabilities); return }
    setForm(current => ({ ...current, capabilities: [...current.capabilities, value] })); setCapabilityDraft(''); setError(null)
  }
  async function save() {
    if (!profile || mutation.current) return
    const value = capabilityDraft.trim()
    const input = { ...form, capabilities: value && !form.capabilities.includes(value) ? [...form.capabilities, value] : form.capabilities }
    const problem = findCompanyPartnerProfileProblem(input)
    if (problem) { setError(messages[problem]); return }
    const controller = new AbortController()
    mutation.current = controller; setSaving(true); setError(null)
    try {
      const saved = await saveCompanyPartnerProfile(token, input, controller.signal)
      if (controller.signal.aborted) return
      setProfile(saved); setForm(toForm(saved)); setCapabilityDraft(''); setEditing(false)
      editVersion.current += 1; setNotice('협업·파트너 설정을 저장했습니다.')
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setError('저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  const interestOptions = [...supportProgramCategories, ...form.interestAreas.filter(area => !supportProgramCategories.includes(area))]
  return <Card>
    <View style={styles.row}><Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>협업·파트너 설정</Text>
      {profile && <StatusBadge label={profile.isSet ? '저장됨' : '미설정'} tone={profile.isSet ? 'success' : 'neutral'} />}
      {loadStatus === 'ready' && <Button label="수정" accessibilityLabel="협업·파트너 설정 수정" size="small" variant="secondary" disabled={disabled} onPress={startEditing} />}
    </View>
    <Text style={styles.muted}>협업 조건을 설정합니다. 담당자 연락처는 이 설정에 포함되지 않습니다.</Text>
    {loadStatus === 'loading' && <ActivityIndicator accessibilityLabel="협업·파트너 설정 불러오는 중" color={colors.primary} />}
    {loadStatus === 'failed' && <><Notice error>협업·파트너 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</Notice>
      <Button label="다시 불러오기" accessibilityLabel="협업·파트너 설정 다시 불러오기" variant="secondary" onPress={() => setRevision(value => value + 1)} /></>}
    {loadStatus === 'company-required' && <><Notice>기업 정보를 다시 확인한 뒤 협업 설정을 등록해 주세요.</Notice>
      <Button label="기업 정보 다시 확인" variant="secondary" onPress={onRefreshCompany} /></>}
    {profile && (profile.isSet ? <>
      <ProfileValue label="참여 가능 역할" value={profile.roles.map(role => partnerRoleLabels[role]).join(' · ')} />
      <ProfileValue label="관심 분야" value={profile.interestAreas.join(' · ')} />
      <ProfileValue label="한 줄 소개" value={profile.introduction} />
      <ProfileValue label="보유 역량" value={profile.capabilities.join(' · ')} />
    </> : <Notice>아직 설정하지 않았습니다. 수정을 눌러 참여 가능 역할과 관심 분야를 채워 주세요.</Notice>)}
    {notice && <Notice>{notice}</Notice>}
    <PartnerSheet visible={editing} title="협업·파트너 설정 수정" onClose={closeEditing} actions={<>
      <Button label="취소" variant="secondary" style={{ flex: 1 }} disabled={saving} onPress={cancelEditing} />
      <Button label="저장" accessibilityLabel="협업·파트너 설정 저장" style={{ flex: 1 }} busy={saving} onPress={() => void save()} />
    </>}>
      <Text style={styles.label}>참여 가능 역할</Text><View style={styles.row}>{ownPartnerRoles.map(role => <ProfileChoice key={role}
        label={partnerRoleLabels[role]} accessibilityLabel={`참여 가능 역할 ${partnerRoleLabels[role]}`} selected={form.roles.includes(role)} disabled={saving} onPress={() => toggleRole(role)} />)}</View>
      <Text style={styles.label}>관심 분야 · 최대 {limits.interestAreaMaxCount}개</Text><View style={styles.row}>{interestOptions.map(area => <ProfileChoice key={area}
        label={area} accessibilityLabel={`관심 분야 ${area}`} selected={form.interestAreas.includes(area)} disabled={saving} onPress={() => toggleInterestArea(area)} />)}</View>
      <Field label="한 줄 소개 (선택)" value={form.introduction} onChangeText={introduction => { setForm(current => ({ ...current, introduction })); setError(null) }}
        multiline maxLength={limits.introductionMaxLength} editable={!saving} placeholder="어떤 일을 하는 팀인지, 어떤 협업을 찾는지 한두 문장으로" />
      <Text style={styles.muted}>{form.introduction.length} / {limits.introductionMaxLength}자</Text>
      <Text style={styles.label}>보유 역량 태그 · 최대 {limits.capabilityMaxCount}개 · 각 {limits.capabilityMaxLength}자</Text>
      <View style={styles.row}>{form.capabilities.map(capability => <Button key={capability} label={`${capability} ×`} accessibilityLabel={`${capability} 보유 역량 삭제`}
        variant="secondary" size="small" disabled={saving} onPress={() => { setForm(current => ({ ...current, capabilities: current.capabilities.filter(value => value !== capability) })); setError(null) }} />)}</View>
      <Field label="보유 역량 입력" value={capabilityDraft} onChangeText={value => { setCapabilityDraft(value); setError(null) }}
        maxLength={limits.capabilityMaxLength} editable={!saving} returnKeyType="done" onSubmitEditing={addCapability} placeholder="예: AI 분석, 제품 설계" />
      <Button label="역량 추가" variant="secondary" disabled={saving} onPress={addCapability} />
      <Text style={styles.muted}>입력 중인 마지막 역량도 저장할 때 함께 반영합니다.</Text>
      {error && <Notice error>{error}</Notice>}
    </PartnerSheet>
  </Card>
}

function ProfileValue({ label, value }: { label: string; value: string }) {
  return <View style={{ gap: 4 }}><Text style={styles.label}>{label}</Text><Text style={value ? styles.body : styles.muted}>{value || '미입력'}</Text></View>
}

function ProfileChoice({ label, accessibilityLabel, selected, disabled, onPress }: {
  label: string; accessibilityLabel: string; selected: boolean; disabled: boolean; onPress(): void
}) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={accessibilityLabel} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: 13, paddingVertical: 9, borderRadius: 22,
      borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.soft : colors.surface, opacity: disabled ? 0.55 : 1 }}>
    <Text style={[styles.body, { color: selected ? colors.primary : colors.text }]}>{label}</Text>
  </Pressable>
}
