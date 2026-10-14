import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { partnerRoleLabels } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { emptyPartnerRecruitmentConditions, type PartnerMatchReason, type PartnerRecruitmentConditions,
  type PartnerRecruitmentRecommendations } from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import type { SupportProgramIdentity } from '@govbiz/shared/domain/repositories/SupportProgramRepository'
import { ApiError, errorMessage } from '../api/client'
import { recommendRecruitments } from '../api/partners'
import { useAuth } from '../auth/session'
import { RecruitmentCard } from '../screens/CollaborationScreen'
import { Button, Notice, StatusBadge, colors, styles } from '../ui'

type Props = { conditions?: PartnerRecruitmentConditions; live: boolean; active: boolean; disabled: boolean
  onOpenPartners?(conditions: PartnerRecruitmentConditions): void; onOpenRecruitment?(id: number): void
  onCompany?(): void; onCreateRecruitment?(program: SupportProgramIdentity): void }
const relaxLabels = { ROLE: '찾는 역할', REGION: '지역', PROGRAM: '선택한 공고' }
function reasonText(reason: PartnerMatchReason) {
  switch (reason.type) {
    case 'MY_PROGRAM': return `${reason.programSource === 'PREPARATION' ? '신청 준비 중인 공고' : '관심 공고'} 「${reason.values[0] ?? ''}」`
    case 'KEYWORD': return `${reason.values.map(value => `'${value}'`).join('·')} 관련`
    case 'CAPABILITY': return `필요 역량 ${reason.values.length}개 일치`
    case 'SAME_REGION': return `같은 지역(${reason.values[0] ?? ''})`
    case 'ROLE': return '찾는 역할이 우리 역할과 맞아요'
  }
}

/** 대화 조건을 해제·재조회하고, 기존 협업 목록·기업 설정·모집 작성으로 연결합니다. */
export function GovPartnerBrief({ conditions = emptyPartnerRecruitmentConditions, live, active, disabled,
  onOpenPartners, onOpenRecruitment, onCompany, onCreateRecruitment }: Props) {
  const { session, invalidateSession } = useAuth()
  const token = session?.accessToken
  const [filters, setFilters] = useState(conditions)
  const [revision, setRevision] = useState(0)
  const [load, setLoad] = useState<{ key: string; result: PartnerRecruitmentRecommendations | null; error: string | null } | null>(null)
  const key = JSON.stringify([token, filters, revision])
  useEffect(() => {
    if (!live || !active || !token) return
    const controller = new AbortController()
    setLoad(null)
    void recommendRecruitments(filters, token, controller.signal).then(result => {
      if (!controller.signal.aborted) setLoad({ key, result, error: null })
    }).catch(cause => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setLoad({ key, result: null, error: errorMessage(cause) })
    })
    return () => controller.abort()
  }, [active, filters, invalidateSession, key, live, token])
  const current = live && active && load?.key === key ? load : null
  const result = current?.result, basis = result?.basis
  const spoken = filters.seekingRoles.length > 0 || filters.regions.length > 0 || filters.keywords.length > 0 || filters.program !== null
  const blocked = disabled || !active
  function drop(type: keyof typeof relaxLabels) {
    setFilters(value => ({ ...value, seekingRoles: type === 'ROLE' ? [] : value.seekingRoles,
      regions: type === 'REGION' ? [] : value.regions, program: type === 'PROGRAM' ? null : value.program }))
  }
  const chip = (label: string, onRemove: () => void) => <Pressable key={label} accessibilityRole="button"
    accessibilityLabel={`${label} 조건 빼기`} disabled={blocked} accessibilityState={{ disabled: blocked }} onPress={onRemove} style={local.chip}>
    <Text style={local.chipText}>{label} ×</Text></Pressable>
  return <View style={local.content} accessibilityLabel="파트너 모집글 · 우리 회사에 맞는 순">
    <View style={local.header}><Text style={styles.heading}>파트너 모집글 {result ? result.total > 0 ? `맞춤 ${result.total}건` : '0건' : ''}</Text>
      <Text style={styles.muted}>우리 회사에 맞는 순</Text></View>
    {basis?.profileSet && <><Text style={styles.muted}>기준: 역할 {basis.roles.map(role => partnerRoleLabels[role]).join('·')} · 역량 {basis.capabilityCount}개 · 관심 공고 {basis.myProgramCount}건</Text>
      {onCompany && <Button label="기준 바꾸기" variant="ghost" disabled={blocked} onPress={onCompany} />}</>}
    {spoken && <View accessibilityLabel="대화에서 읽은 조건" style={local.content}>
      <Text style={styles.muted}>대화에서 읽은 조건</Text><View style={local.header}>
        {filters.seekingRoles.length > 0 && chip(filters.seekingRoles.map(role => partnerRoleLabels[role]).join('·'), () => drop('ROLE'))}
        {filters.regions.length > 0 && chip(`${filters.regions.join('·')}·전국`, () => drop('REGION'))}
        {filters.program && chip('선택한 공고', () => drop('PROGRAM'))}
        {filters.keywords.map(keyword => chip(`${keyword} (순서만)`, () => setFilters(value => ({ ...value, keywords: value.keywords.filter(item => item !== keyword) }))))}
      </View></View>}
    {basis && !basis.profileSet && <View style={local.notice}>
      <Text style={styles.body}>{basis.hasCompany ? '참여 가능 역할·역량을 채우면 더 맞춰 드려요.' : '기업을 등록하고 역할·역량을 채우면 더 맞춰 드려요.'}</Text>
      {onCompany && <Button label={basis.hasCompany ? '협업·파트너 설정' : '기업 등록하기'} variant="secondary" disabled={blocked} onPress={onCompany} />}
    </View>}
    {live && active && !current && <ActivityIndicator accessibilityLabel="파트너 모집글 확인 중" color={colors.primary} />}
    {current?.error && <><Notice error>{current.error}</Notice><Button label="파트너 모집글 다시 확인" variant="secondary" disabled={blocked} onPress={() => setRevision(value => value + 1)} /></>}
    {result?.items.map(({ recruitment, reasons, cautions }) => <RecruitmentCard key={recruitment.id} item={recruitment}
      disabled={blocked} onOpen={() => onOpenRecruitment?.(recruitment.id)}>
      <View style={local.header} accessibilityLabel="추천 이유">
        {reasons.slice(0, 2).map(reason => <StatusBadge key={reason.type} label={reasonText(reason)} tone="success" />)}
        {cautions.slice(0, 1).map(caution => <StatusBadge key={caution.type} label={caution.type === 'OTHER_REGION'
          ? `희망 지역 ${caution.value}${basis?.region ? ` · 우리 ${basis.region}` : ''}` : `업력 ${caution.value}년 이상`} />)}
      </View>
    </RecruitmentCard>)}
    {result && result.items.length === 0 && <View style={local.notice}>
      <Text style={styles.body}>{spoken ? '조건에 맞는 열린 모집글이 없어요.' : '지금 우리 회사에 맞는 열린 모집글이 없어요.'}</Text>
      {result.relax.filter(item => item.count > 0).map(item => <Button key={item.type} label={`${relaxLabels[item.type]} 빼고 보기 (${item.count}건)`}
        variant="secondary" disabled={blocked} onPress={() => drop(item.type)} />)}
    </View>}
    {result?.suggestedProgram && <View style={local.notice}>
      <Text style={styles.body}>관심 공고 「{result.suggestedProgram.title}」에는 아직 모집글이 없어요.</Text>
      {onCreateRecruitment && <Button label="이 공고로 모집글 쓰기" variant="secondary" disabled={blocked}
        onPress={() => onCreateRecruitment(result.suggestedProgram!)} />}
    </View>}
    {onOpenPartners && <Button label={spoken ? '같은 조건으로 파트너 관리에서 보기' : '파트너 관리에서 전체 보기'}
      disabled={blocked} onPress={() => onOpenPartners(filters)} />}
  </View>
}
const local = StyleSheet.create({
  content: { gap: 12 }, header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  notice: { padding: 14, gap: 12, borderRadius: 16, backgroundColor: colors.background },
  chip: { borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: 999, paddingHorizontal: 10, minHeight: 44, justifyContent: 'center' },
  chipText: { color: colors.primaryText, fontSize: 13 },
})
