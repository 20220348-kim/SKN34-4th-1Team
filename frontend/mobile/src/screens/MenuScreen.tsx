import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useAuth } from '../auth/session'
import { AppIcon, type AppIconName } from '../components/AppIcon'
import { Button, Notice, Page, colors } from '../ui'

export type MenuDestination = 'account' | 'company' | 'settings' | 'filter' | 'ai' | 'saved' | 'report'
  | 'documents' | 'reviews' | 'recruitments' | 'received' | 'sent' | 'mine'
type MenuItem = { destination: MenuDestination; label: string; description: string; icon: AppIconName }
const normalize = (value: string) => value.replace(/\s/g, '').toLowerCase()

export function MenuScreen({ onOpen }: { onOpen(destination: MenuDestination): void }) {
  const { status, session, restoreError } = useAuth()
  const [query, setQuery] = useState('')
  if (status === 'loading') return <Page headerless backgroundColor={colors.surface}><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page headerless><Notice error>{restoreError ?? '로그인 상태를 확인하지 못했습니다.'}</Notice>
    <Button label="로그인 상태 확인" onPress={() => onOpen('account')} /></Page>
  const account = status === 'signedIn' ? session?.account : null
  const groups: { title: string; items: MenuItem[] }[] = [
    { title: '내 정보', items: [
      { destination: 'account', label: '내 계정', description: '이메일 · 로그인 관리', icon: 'account' },
      { destination: 'company', label: account?.company ? '기업 정보' : '기업 정보 등록', description: '지역 · 업종 · 설립연도', icon: 'building' },
      { destination: 'settings', label: '리포트 수신 설정', description: '정기 이메일 수신', icon: 'bell' },
    ] },
    { title: '지원사업 찾기', items: [
      { destination: 'filter', label: '공고 검색', description: '조건으로 찾기', icon: 'search' },
      { destination: 'ai', label: 'AI 검색', description: '대화로 찾기', icon: 'message' },
      { destination: 'saved', label: '관심 공고함', description: '담은 공고 · 준비 작업', icon: 'bookmark' },
      { destination: 'report', label: '맞춤 리포트', description: '기업 조건 추천', icon: 'report' },
    ] },
    { title: '신청 준비', items: [
      { destination: 'documents', label: '신청 문서', description: '작성 중 · 초안 완료', icon: 'document' },
      { destination: 'reviews', label: '중복 검토', description: '공고 조합 검토', icon: 'shield' },
    ] },
    { title: '협업', items: [
      { destination: 'recruitments', label: '모집글', description: '파트너 찾기', icon: 'collaboration' },
      { destination: 'received', label: '받은 제안', description: '받은 제안 내역', icon: 'inbox' },
      { destination: 'sent', label: '보낸 제안', description: '보낸 제안 내역', icon: 'outbox' },
      { destination: 'mine', label: '내 모집글', description: '작성한 모집글', icon: 'pencil' },
    ] },
  ]
  const filtered = groups.map((group) => ({ ...group, items: group.items.filter((item) =>
    normalize(item.label + item.description).includes(normalize(query))) })).filter((group) => group.items.length)
  return <Page headerless backgroundColor={colors.surface}>
    <View style={local.profile}>
      <Pressable accessibilityRole="button" accessibilityLabel="내 계정 열기" onPress={() => onOpen('account')} style={local.identity}>
        <Text style={local.name}>{account?.company?.companyName ?? (account ? '내 계정' : '로그인해 주세요')}</Text>
        {!account?.company && <Text style={local.email}>{account?.email ?? '계정과 관심 공고를 이어서 사용하세요'}</Text>}
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="내 정보 열기" onPress={() => onOpen('account')} style={local.account}>
        <Text style={local.meta}>내 정보</Text><AppIcon name="account" color={colors.muted} size={19} />
      </Pressable>
    </View>
    {restoreError && <Notice error>{restoreError}</Notice>}
    <View style={local.search}><AppIcon name="search" color={colors.muted} size={23} />
      <TextInput accessibilityLabel="메뉴 검색" placeholder="메뉴 검색" placeholderTextColor={colors.placeholder}
        value={query} onChangeText={setQuery} autoCorrect={false} style={local.input} />
      {query.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel="메뉴 검색 지우기"
        onPress={() => setQuery('')} style={local.clear}><Text style={local.clearText}>×</Text></Pressable>}
    </View>
    {filtered.length === 0 && <Text accessibilityLiveRegion="polite" style={local.empty}>검색한 메뉴가 없어요.</Text>}
    {filtered.map((group) => <View key={group.title} style={local.group}>
      <Text accessibilityRole="header" style={local.heading}>{group.title}</Text>
      {group.items.map((item) => <Pressable key={item.destination} accessibilityRole="button" accessibilityLabel={item.label}
        accessibilityHint={item.description} onPress={() => onOpen(item.destination)}
        style={({ pressed }) => [local.row, pressed && { backgroundColor: colors.background }]}>
        <View style={local.icon}><AppIcon name={item.icon} color={colors.primary} size={22} /></View>
        <Text style={local.label}>{item.label}</Text><Text style={local.description}>{item.description}</Text>
      </Pressable>)}
    </View>)}
  </Page>
}

const local = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 10 },
  identity: { flex: 1, minHeight: 44, justifyContent: 'center' }, name: { fontSize: 23, fontWeight: '700', color: colors.text },
  email: { fontSize: 13, lineHeight: 20, color: colors.muted, marginTop: 5 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 }, meta: { fontSize: 13, color: colors.muted },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, paddingHorizontal: 14, borderRadius: 15,
    backgroundColor: colors.background, marginBottom: 10 }, input: { flex: 1, minWidth: 0, fontSize: 16, paddingVertical: 13, color: colors.text },
  clear: { minHeight: 44, minWidth: 32, alignItems: 'center', justifyContent: 'center' }, clearText: { fontSize: 22, color: colors.muted },
  group: { marginBottom: 12 }, heading: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingVertical: 7, borderRadius: 12 },
  icon: { width: 35, height: 35, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  label: { flex: 1, flexShrink: 1, color: colors.text, fontSize: 16, lineHeight: 24, fontWeight: '500' },
  description: { flex: 1, flexShrink: 1, color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'right' },
  empty: { paddingVertical: 26, color: colors.muted, fontSize: 14, lineHeight: 24 },
})
