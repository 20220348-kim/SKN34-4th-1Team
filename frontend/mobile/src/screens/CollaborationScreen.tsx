import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { partnerRoleLabels, seekingPartnerRoles, type PartnerRecruitmentSummary } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { defaultPartnerRecruitmentQuery, partnerRecruitmentSortLabels, type PartnerRecruitmentQuery } from '@govbiz/shared/domain/entities/PartnerRecruitmentQuery'
import { partnerProposalStatusLabels, type PartnerProposal, type PartnerProposalBox, type PartnerProposalBoxPage } from '@govbiz/shared/domain/entities/PartnerProposal'
import { regionNamesWithoutNationwide } from '@govbiz/shared/domain/entities/Region'
import { browseProposals, browseRecruitments, getProposal, partnerErrorMessage, respondProposal } from '../api/partners'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/session'
import { useScrollBoundary } from '../components/useScrollBoundary'
import { Button, Card, Notice, StatusBadge, colors, styles } from '../ui'
import { PartnerSheet } from '../components/PartnerSheet'
import { AppIcon } from '../components/AppIcon'
import { partnerMonthDay, recruitmentDeadlineLabel, recruitmentDeadlineTone } from '../components/PartnerDates'
import { SegmentedControl } from '../components/SegmentedControl'

type ViewMode = 'recruitments' | 'box'
type ProposalFilter = 'all' | 'pending' | 'accepted' | 'ended'
type RecruitmentState = { owner: string | null; mineOnly: boolean; items: PartnerRecruitmentSummary[]; total: number; totalPages: number; loading: boolean; error: string | null }
type BoxState = { owner: string | null; page: PartnerProposalBoxPage | null; loading: boolean; error: string | null }
const emptyRecruitments = (owner: string | null, mineOnly = false): RecruitmentState => ({ owner, mineOnly, items: [], total: 0, totalPages: 0, loading: true, error: null })
const emptyBox = (owner: string | null): BoxState => ({ owner, page: null, loading: true, error: null })

export function CollaborationScreen({ view, onViewChange, onPendingCount, onOpenRecruitment, onLogin, initialBox = 'received', mineOnly = false, management = false, onManagementTabChange }: {
  initialBox?: PartnerProposalBox; mineOnly?: boolean; management?: boolean; onManagementTabChange?(tab: 'received' | 'sent' | 'mine'): void
  view: ViewMode; onViewChange(value: ViewMode): void; onPendingCount?(count: number): void
  onOpenRecruitment(id: number): void; onLogin(): void
}) {
  const { session, status, invalidateSession } = useAuth()
  const scrollBoundary = useScrollBoundary(true)
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [query, setQuery] = useState<PartnerRecruitmentQuery>({ ...defaultPartnerRecruitmentQuery, mineOnly })
  const [keyword, setKeyword] = useState('')
  const [box, setBox] = useState<PartnerProposalBox>(initialBox)
  const [filter, setFilter] = useState<ProposalFilter>('all')
  const [recruitmentState, setRecruitmentState] = useState<RecruitmentState>(() => emptyRecruitments(token, mineOnly))
  const [receivedState, setReceivedState] = useState<BoxState>(() => emptyBox(token))
  const [sentState, setSentState] = useState<BoxState>(() => emptyBox(token))
  const [revision, setRevision] = useState(0)
  const [filterOpen, setFilterOpen] = useState(false)
  const [selection, setSelection] = useState<{ owner: string; proposal: PartnerProposal } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => { setBox(initialBox); setFilter('all') }, [initialBox])
  useEffect(() => { setQuery((current) => current.mineOnly === mineOnly ? current : { ...current, mineOnly, page: 1 }) }, [mineOnly])

  useFocusEffect(useCallback(() => {
    const controller = new AbortController()
    setRecruitmentState((current) => current.owner === token && current.mineOnly === query.mineOnly && current.items.length
      ? { ...current, loading: true, error: null } : emptyRecruitments(token, query.mineOnly))
    if (!query.mineOnly || token) void browseRecruitments(query, token ?? undefined, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      setRecruitmentState((current) => ({ owner: token, mineOnly: query.mineOnly, items: query.page > 1 && current.owner === token && current.mineOnly === query.mineOnly
        ? [...current.items.filter((item) => !page.recruitments.some((next) => next.id === item.id)), ...page.recruitments]
        : page.recruitments, total: page.total, totalPages: page.totalPages, loading: false, error: null }))
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setRecruitmentState((current) => ({ ...current, loading: false, error: partnerErrorMessage(cause) }))
    })
    if (!token) {
      setReceivedState(emptyBox(null)); setSentState(emptyBox(null)); onPendingCount?.(0)
    } else {
      setReceivedState((current) => current.owner === token && current.page ? { ...current, loading: true } : emptyBox(token))
      void browseProposals('received', token, controller.signal).then((page) => {
        if (controller.signal.aborted) return
        setReceivedState({ owner: token, page, loading: false, error: null })
        onPendingCount?.(page.pendingCount)
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
        setReceivedState({ ...emptyBox(token), loading: false, error: partnerErrorMessage(cause) })
      })
      if (box === 'sent') {
        setSentState((current) => current.owner === token && current.page ? { ...current, loading: true } : emptyBox(token))
        void browseProposals('sent', token, controller.signal).then((page) => {
          if (!controller.signal.aborted) setSentState({ owner: token, page, loading: false, error: null })
        }).catch((cause: unknown) => {
          if (controller.signal.aborted) return
          if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
          setSentState({ ...emptyBox(token), loading: false, error: partnerErrorMessage(cause) })
        })
      }
    }
    return () => controller.abort()
  }, [box, query, revision, token, invalidateSession, onPendingCount]))

  const visibleRecruitments = recruitmentState.owner === token && recruitmentState.mineOnly === (management && view === 'recruitments' || query.mineOnly)
    ? recruitmentState : emptyRecruitments(token, query.mineOnly)
  const selected = selection?.owner === token ? selection.proposal : null
  const visibleBox = (box === 'received' ? receivedState : sentState).owner === token
    ? box === 'received' ? receivedState : sentState : emptyBox(token)
  const pendingCount = receivedState.owner === token ? receivedState.page?.pendingCount ?? 0 : 0
  const proposals = visibleBox.page?.proposals ?? []
  const filteredProposals = proposals.filter((proposal) => filter === 'all'
    || filter === 'pending' && proposal.status === 'PENDING'
    || filter === 'accepted' && proposal.status === 'ACCEPTED'
    || filter === 'ended' && ['DECLINED', 'WITHDRAWN', 'EXPIRED'].includes(proposal.status))

  function changeQuery(patch: Partial<PartnerRecruitmentQuery>) {
    setQuery((current) => ({ ...current, ...patch, page: 1 }))
  }

  function toggleFilter<K extends 'seekingRoles' | 'regions'>(key: K, value: PartnerRecruitmentQuery[K][number]) {
    setQuery((current) => {
      const list = current[key] as string[]
      return { ...current, [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value], page: 1 }
    })
  }

  async function openProposal(proposal: PartnerProposal) {
    if (!token) { onLogin(); return }
    setSelection({ owner: token, proposal }); setDetailLoading(true); setDetailError(null)
    try {
      const latest = await getProposal(proposal.id, token)
      setSelection((current) => current?.owner === token && current.proposal.id === latest.id
        ? { owner: token, proposal: latest } : current)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setDetailError(partnerErrorMessage(cause))
    } finally { setDetailLoading(false) }
  }

  async function actOnProposal(action: 'accept' | 'decline' | 'withdraw') {
    if (!selected || !token || actionBusy) return
    setActionBusy(true); setDetailError(null)
    try {
      const updated = await respondProposal(selected.id, action, token)
      setSelection({ owner: token, proposal: updated })
      setRevision((value) => value + 1)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) void invalidateSession().catch(() => undefined)
      setDetailError(partnerErrorMessage(cause))
    } finally { setActionBusy(false) }
  }

  function confirmAction(action: 'accept' | 'decline' | 'withdraw') {
    const label = action === 'accept' ? '수락' : action === 'decline' ? '거절' : '철회'
    Alert.alert(`제안을 ${label}할까요?`, action === 'accept' ? '수락하면 두 기업의 연락처가 공개됩니다.' : '처리한 제안은 되돌릴 수 없습니다.', [
      { text: '취소', style: 'cancel' }, { text: label, style: action === 'accept' ? 'default' : 'destructive', onPress: () => void actOnProposal(action) },
    ])
  }

  if (status === 'loading') return <View style={local.loading}><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" color={colors.primary} /></View>
  if (status === 'unavailable') return <View style={local.loading}><Notice error>로그인 상태를 확인하지 못했습니다.</Notice></View>

  return <View style={local.page}>
    {token && <View style={local.header}>{management
      ? <SegmentedControl<'received' | 'sent' | 'mine'> label="파트너 관리 구분" value={view === 'recruitments' ? 'mine' : box}
        options={[{ value: 'received', label: `받은 제안${pendingCount ? ` ${pendingCount}` : ''}` }, { value: 'sent', label: '보낸 제안' }, { value: 'mine', label: '내 모집글' }]}
        onChange={tab => { if (tab !== 'mine') { setBox(tab); setFilter('all') } changeQuery({ mineOnly: tab === 'mine' });
          if (onManagementTabChange) onManagementTabChange(tab); else onViewChange(tab === 'mine' ? 'recruitments' : 'box') }} />
      : <SegmentedControl label="협업 보기" value={view} onChange={onViewChange}
        options={[{ value: 'recruitments', label: '모집글' }, { value: 'box', label: `제안함 ${pendingCount || ''}`.trim() }]} />}</View>}
    {view === 'recruitments' && query.mineOnly && !token ? <View style={local.list}><Notice>내 모집글은 로그인 후 확인할 수 있어요.</Notice><Button label="로그인하기" onPress={onLogin} /></View>
    : view === 'recruitments' ? <FlatList {...scrollBoundary} data={visibleRecruitments.items} keyExtractor={(item) => String(item.id)}
      contentContainerStyle={local.list} keyboardShouldPersistTaps="handled"
      refreshing={visibleRecruitments.loading && visibleRecruitments.items.length > 0}
      onRefresh={() => setRevision((value) => value + 1)}
      ListHeaderComponent={<View style={local.listHeader}>
        <View style={local.searchRow}><TextInput accessibilityLabel="역량·공고명 검색" placeholder="역량 · 공고명 검색"
          placeholderTextColor={colors.placeholder} value={keyword} onChangeText={setKeyword} returnKeyType="search"
          onSubmitEditing={() => changeQuery({ keyword })} style={local.searchInput} />
          <Button label={`필터${query.regions.length + query.seekingRoles.length ? ` ${query.regions.length + query.seekingRoles.length}` : ''}`}
            size="small" variant="secondary" onPress={() => setFilterOpen(true)} /></View>
        <View style={local.row}>{token && !management && <Pressable accessibilityRole="button" accessibilityState={{ selected: query.mineOnly }}
          onPress={() => token ? changeQuery({ mineOnly: !query.mineOnly }) : onLogin()} style={local.chip}>
          <Text style={styles.muted}>내가 쓴 글</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel={partnerRecruitmentSortLabels[query.sort]}
            onPress={() => changeQuery({ sort: query.sort === 'DEADLINE' ? 'RECENT' : 'DEADLINE' })} style={local.sort}>
            <Text style={styles.muted}>{partnerRecruitmentSortLabels[query.sort]} ▾</Text></Pressable></View>
        {visibleRecruitments.error && <Notice error>{visibleRecruitments.error}</Notice>}
        {!visibleRecruitments.error && <Text style={styles.muted}>모집글 {visibleRecruitments.total}건</Text>}
      </View>}
      ListEmptyComponent={visibleRecruitments.loading ? <ActivityIndicator accessibilityLabel="모집글 불러오는 중" color={colors.primary} />
        : visibleRecruitments.error ? null : <Notice>조건에 맞는 모집글이 없습니다.</Notice>}
      renderItem={({ item }) => <RecruitmentCard item={item} onOpen={() => onOpenRecruitment(item.id)} />}
      ListFooterComponent={query.page < visibleRecruitments.totalPages && !visibleRecruitments.error
        ? <Button label="더 보기" variant="secondary" disabled={visibleRecruitments.loading}
          onPress={() => setQuery((current) => ({ ...current, page: current.page + 1 }))} /> : null} />
    : !token ? <View style={local.list}><Notice>제안함은 로그인 후 확인할 수 있어요.</Notice><Button label="로그인하기" onPress={onLogin} /></View>
      : <FlatList {...scrollBoundary} data={filteredProposals} keyExtractor={(item) => String(item.id)} contentContainerStyle={local.list}
        refreshing={visibleBox.loading && Boolean(visibleBox.page)} onRefresh={() => setRevision((value) => value + 1)}
        ListHeaderComponent={<View style={local.listHeader}>
          {!management && <SegmentedControl label="제안함 구분" value={box} onChange={(next) => { setBox(next); setFilter('all') }}
            options={[{ value: 'received', label: '받은 제안' }, { value: 'sent', label: '보낸 제안' }]} />}
          {visibleBox.page && <View style={local.row}>{([
            ['all', `전체 ${proposals.length}`], ['pending', `대기 ${proposals.filter((item) => item.status === 'PENDING').length}`],
            ['accepted', `수락 ${proposals.filter((item) => item.status === 'ACCEPTED').length}`],
            ['ended', `종료 ${proposals.filter((item) => ['DECLINED', 'WITHDRAWN', 'EXPIRED'].includes(item.status)).length}`],
          ] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="button"
            accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)}
            style={[local.chip, filter === value && local.selectedChip]}>
            <Text style={[styles.muted, filter === value && local.activeFilter]}>{label}</Text></Pressable>)}</View>}
          {visibleBox.error && <Notice error>{visibleBox.error}</Notice>}
        </View>}
        ListEmptyComponent={visibleBox.loading ? <ActivityIndicator accessibilityLabel="제안함 불러오는 중" color={colors.primary} />
          : visibleBox.error ? null : <Notice>이 상태의 제안이 없습니다.</Notice>}
        renderItem={({ item }) => <ProposalCard item={item} onOpen={() => void openProposal(item)} />} />}
    <PartnerSheet visible={filterOpen} title="모집글 필터" onClose={() => setFilterOpen(false)}
      actions={<Button label="결과 보기" onPress={() => setFilterOpen(false)} />}>
      <Text style={styles.heading}>찾는 역할</Text>
      <View style={local.row}>{seekingPartnerRoles.map((role) => <FilterChip key={role} label={partnerRoleLabels[role]}
        selected={query.seekingRoles.includes(role)} onPress={() => toggleFilter('seekingRoles', role)} />)}</View>
      <Text style={styles.heading}>지역</Text>
      <View style={local.row}>{regionNamesWithoutNationwide.map((region) => <FilterChip key={region} label={region}
        selected={query.regions.includes(region)} onPress={() => toggleFilter('regions', region)} />)}</View>
      <Button label="필터 초기화" variant="ghost" onPress={() => changeQuery({ seekingRoles: [], regions: [] })} />
    </PartnerSheet>
    <PartnerSheet visible={selected !== null} title={selected?.isSent ? '보낸 제안' : '받은 제안'} onClose={() => { setSelection(null); setDetailError(null) }}
      actions={selected?.status === 'PENDING' ? <>
        {selected.isSent ? <Button label="제안 철회" variant="danger" disabled={actionBusy} onPress={() => confirmAction('withdraw')} />
          : <><Button label="거절" variant="danger" disabled={actionBusy} onPress={() => confirmAction('decline')} />
            <Button label="수락" disabled={actionBusy} busy={actionBusy} onPress={() => confirmAction('accept')} /></>}
      </> : selected?.status === 'ACCEPTED' ? <Button label="메일 앱 열기" onPress={() => {
        const email = selected.counterpart.contact?.email
        if (!email) { setDetailError('공개된 연락처를 확인하지 못했습니다.'); return }
        void Linking.openURL(`mailto:${encodeURIComponent(email)}`).catch(() => setDetailError('메일 앱을 열지 못했습니다.'))
      }} /> : <Button label="닫기" variant="secondary" onPress={() => setSelection(null)} />}>
      {selected && <>
        {detailLoading && <ActivityIndicator accessibilityLabel="제안 상세 불러오는 중" color={colors.primary} />}
        {detailError && <Notice error>{detailError}</Notice>}
        <View style={local.statusPill}><StatusBadge label={partnerProposalStatusLabels[selected.status]}
          tone={selected.status === 'ACCEPTED' ? 'success' : selected.status === 'PENDING' ? 'info' : 'neutral'} /></View>
        <View style={local.detailPanel}><Card><Text style={styles.heading}>{selected.counterpart.companyName}</Text>
          {selected.counterpart.profile && <Text style={styles.muted}>{selected.counterpart.profile.region} · {selected.counterpart.profile.industry} · {selected.counterpart.profile.foundedYear}년 설립</Text>}</Card></View>
        <View style={local.detailPanel}><Card><Text style={styles.muted}>연결된 모집 공고</Text><Text style={styles.heading}>{selected.recruitment.title}</Text>
          <Button label="모집글 상세 보기" variant="ghost" onPress={() => { setSelection(null); onOpenRecruitment(selected.recruitment.id) }} /></Card></View>
        <View style={local.detailPanel}><Card><Text style={styles.muted}>제안 메시지</Text><Text style={styles.body}>{selected.message}</Text></Card></View>
        <View style={local.dates}><DateLine icon="send" label={`제안 날짜 ${partnerMonthDay(selected.createdAt)}`} />
          <DateLine icon="calendar" label={`응답 기한 ${partnerMonthDay(selected.expiresAt)}`} /></View>
        <View style={local.detailPanel}><Card><Text style={styles.muted}>연락처</Text>
          {selected.status === 'ACCEPTED' && selected.counterpart.contact
            ? <><Text style={styles.body}>이메일 {selected.counterpart.contact.email}</Text>
              <Text style={styles.body}>사업자번호 {selected.counterpart.contact.businessNumber}</Text></>
            : <Text style={styles.muted}>{selected.status === 'ACCEPTED'
              ? '연락처를 확인하지 못했습니다.' : '수락하면 공개돼요'}</Text>}</Card></View>
      </>}
    </PartnerSheet>
  </View>
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: selected }}
    onPress={onPress} style={[local.chip, selected && local.selectedChip]}><Text style={[styles.muted, selected && { color: colors.primary }]}>{label}</Text></Pressable>
}

function RecruitmentCard({ item, onOpen }: { item: PartnerRecruitmentSummary; onOpen(): void }) {
  return <Card>
    <View style={local.cardTop}><StatusBadge label={item.status === 'OPEN' ? '모집 중' : '모집 마감'} tone={item.status === 'OPEN' ? 'info' : 'neutral'} />
      <RecruitmentDeadline date={item.recruitmentDeadline} />
      <View style={{ flex: 1 }} /><Button label="상세 보기" size="small" variant="secondary" onPress={onOpen} /></View>
    <Text style={styles.heading}>{item.title}</Text>
    <Text style={styles.muted}>{item.program.title}</Text>
    <View style={local.author}><Text style={local.avatar}>{item.company.companyName.slice(0, 1)}</Text>
      <View><Text style={styles.body}>{item.company.companyName}</Text><Text style={styles.muted}>{item.company.region} · {item.company.industry}</Text></View></View>
    <Text style={styles.muted}>지역 · {item.region}</Text>
    <View style={local.cardFoot}><View style={local.footItem}><AppIcon name="collaboration" color={colors.muted} size={16} />
      <Text style={styles.muted}>{partnerRoleLabels[item.seekingRole]} {item.seekingCount}곳</Text></View>
      <View style={local.footItem}><AppIcon name="message" color={colors.muted} size={16} />
        <Text style={styles.muted}>제안 {item.proposalCount}건</Text></View></View>
  </Card>
}

function ProposalCard({ item, onOpen }: { item: PartnerProposal; onOpen(): void }) {
  return <Card>
    <View style={local.cardTop}><Text style={local.avatar}>{item.counterpart.companyName.slice(0, 1)}</Text>
      <Text style={styles.heading}>{item.counterpart.companyName}</Text>
      <View style={{ flex: 1 }} /><StatusBadge label={partnerProposalStatusLabels[item.status]}
        tone={item.status === 'ACCEPTED' ? 'success' : item.status === 'PENDING' ? 'info' : 'neutral'} /></View>
    <Text style={styles.muted} numberOfLines={1}>{item.recruitment.title}</Text>
    <Text style={local.preview} numberOfLines={3}>{item.message}</Text>
    <View style={local.cardFoot}><View style={local.dates}><DateLine icon="send" label={`제안 날짜 ${partnerMonthDay(item.createdAt)}`} />
      <DateLine icon="calendar" label={`응답 기한 ${partnerMonthDay(item.expiresAt)}`} /></View>
      <Button label="열기" size="small" variant="secondary" onPress={onOpen} /></View>
  </Card>
}

function DateLine({ icon, label }: { icon: 'send' | 'calendar'; label: string }) {
  return <View style={local.dateLine}><AppIcon name={icon} color={colors.muted} size={15} />
    <Text style={styles.muted}>{label}</Text></View>
}

function RecruitmentDeadline({ date }: { date: string }) {
  return <StatusBadge label={recruitmentDeadlineLabel(date)}
    tone={recruitmentDeadlineTone(date)} />
}

const local = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: { backgroundColor: colors.surface, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  listHeader: { gap: 12, marginBottom: 2 },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  searchInput: { flex: 1, minHeight: 44, minWidth: 0, backgroundColor: colors.surface, borderRadius: 999,
    paddingHorizontal: 14, fontSize: 16, color: colors.text, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  chip: { minHeight: 48, borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 11, justifyContent: 'center', backgroundColor: colors.surface },
  selectedChip: { backgroundColor: colors.soft, borderColor: colors.primary },
  sort: { marginLeft: 'auto', minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' },
  activeFilter: { color: colors.info, fontWeight: '700' },
  cardTop: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  author: { backgroundColor: colors.background, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, color: colors.primary,
    textAlign: 'center', textAlignVertical: 'center', lineHeight: 32, overflow: 'hidden' },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 9 },
  footItem: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  statusPill: { alignSelf: 'flex-start' },
  detailPanel: { borderWidth: 1, borderColor: colors.border, borderRadius: 16 },
  dates: { gap: 3, flexShrink: 1 },
  dateLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  preview: { backgroundColor: colors.background, padding: 10, borderRadius: 10, fontSize: 13, lineHeight: 21, color: colors.secondaryText },
})
