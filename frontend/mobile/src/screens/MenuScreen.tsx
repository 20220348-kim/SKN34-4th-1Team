import { useState } from 'react'
import { screenTitles } from '@govbiz/shared/design/screenTitles'
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useAuth } from '../auth/session'
import { useAssistantBlock } from '../assistant/context'
import { WelcomeScreen } from './WelcomeScreen'
import { AppIcon, type AppIconName } from '../components/AppIcon'
import { MenuPressable } from '../components/MenuPressable'
import { Button, Notice, Page, colors } from '../ui'
// skn-501: 운영 문서·문의처 확정 전에는 안내 진입점을 노출하지 않습니다. 확정 후 주석을 해제합니다.
// import { ServiceInformationSheet } from '../components/ServiceInformationSheet'
// import { serviceContact, serviceInformation, type ServiceInformationSection } from '../content/serviceInformation'

export type MenuDestination = 'account' | 'company' | 'settings' | 'filter' | 'ai' | 'saved' | 'report'
  | 'partners' | 'documents' | 'reviews' | 'recruitments' | 'received' | 'sent' | 'mine' | 'pricing' | 'assistant'
type MenuItem = { destination: MenuDestination /* | ServiceInformationSection */; label: string; description: string; icon: AppIconName }

export function MenuScreen({ onOpen }: { onOpen(destination: MenuDestination): void }) {
  const { status, session, restoreError } = useAuth()
  const [introOpen, setIntroOpen] = useState(false)
  useAssistantBlock(introOpen)
  // const [information, setInformation] = useState<ServiceInformationSection | null>(null)
  const closeIntroduction = () => setIntroOpen(false)
  if (status === 'loading') return <Page headerless backgroundColor={colors.surface}><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page headerless><Notice error>{restoreError ?? '로그인 상태를 확인하지 못했습니다.'}</Notice>
    <Button label="로그인 상태 확인" onPress={() => onOpen('account')} />
    {/* skn-501: 미확정 정책·도움말·문의 안내 보류
    <Button label="개인정보 처리방침" variant="ghost" onPress={() => setInformation('privacy')} />
    <Button label="이용약관" variant="ghost" onPress={() => setInformation('terms')} />
    <Button label="도움말·문의" variant="ghost" onPress={() => setInformation('support')} />
    <ServiceInformationSheet section={information} onClose={() => setInformation(null)} />
    */}</Page>
  const account = status === 'signedIn' ? session?.account : null
  const groups: { title: string; items: MenuItem[] }[] = [
    { title: '내 정보', items: [
      { destination: 'account', label: screenTitles.profile, description: '이메일 · 로그인 관리', icon: 'account' },
    ] },
    { title: '지원사업 찾기', items: [
      { destination: 'filter', label: screenTitles.filterSearch, description: '조건으로 찾기', icon: 'search' },
      { destination: 'ai', label: screenTitles.aiSearch, description: '대화로 찾기', icon: 'message' },
      { destination: 'saved', label: screenTitles.savedPrograms, description: '담은 공고 · 준비 작업', icon: 'bookmark' },
      { destination: 'report', label: screenTitles.reports, description: '기업 조건 추천', icon: 'report' },
    ] },
    { title: '신청 준비', items: [
      { destination: 'documents', label: screenTitles.applicationPreparations, description: '작성 중 · 초안 완료', icon: 'document' },
      { destination: 'reviews', label: screenTitles.combinationReviews, description: '공고 조합 검토', icon: 'shield' },
    ] },
    { title: '협업', items: [
      { destination: 'recruitments', label: screenTitles.publicPartners, description: '파트너 찾기', icon: 'recruitment' },
      { destination: 'partners', label: screenTitles.partnerManagement, description: '제안 · 내 모집글', icon: 'collaboration' },
    ] },
    { title: '서비스 안내', items: [
      ...(account ? [{ destination: 'assistant' as const, label: 'GovBiz 도우미', description: '사용법 · 질문하기', icon: 'message' as const }] : []),
      { destination: 'pricing', label: screenTitles.pricing, description: '기능 · 이용 안내', icon: 'creditCard' },
      /* skn-501: 미확정 정책·도움말·문의 안내 보류
      { destination: 'privacy', label: '개인정보 처리방침', description: serviceInformation.privacy.preparing ? '문서 초안' : '문서 읽기', icon: 'document' },
      { destination: 'terms', label: '이용약관', description: serviceInformation.terms.preparing ? '문서 초안' : '문서 읽기', icon: 'document' },
      { destination: 'support', label: '도움말·문의', description: serviceContact.email || serviceContact.url ? '도움말 · 문의처' : '도움말 · 문의처 준비 중', icon: 'message' },
      */
    ] },
  ]
  return <><View style={{ flex: 1 }} accessibilityElementsHidden={introOpen} importantForAccessibility={introOpen ? 'no-hide-descendants' : 'auto'}>
    <Page headerless backgroundColor={colors.surface}>
    <View style={local.profile}>
      <View style={local.identity}>
        <Text style={local.name}>{account?.company?.companyName ?? (account ? screenTitles.profile : '로그인해 주세요')}</Text>
        {!account?.company && <Text style={local.email}>{account?.email ?? '계정과 관심 공고를 이어서 사용하세요'}</Text>}
      </View>
    </View>
    {restoreError && <Notice error>{restoreError}</Notice>}
    {groups.map((group) => <View key={group.title} style={local.group}>
      <Text accessibilityRole="header" style={local.heading}>{group.title}</Text>
      {group.items.map((item) => <MenuPressable key={item.destination} accessibilityRole="button" accessibilityLabel={item.label}
        accessibilityHint={item.description} onPress={() => {
          /* skn-501: 미확정 안내 시트 연결 보류
          if (item.destination === 'terms' || item.destination === 'privacy' || item.destination === 'support') setInformation(item.destination)
          else
          */
          onOpen(item.destination)
        }}
        style={({ pressed }) => [local.row, pressed && { backgroundColor: `${colors.text}05` }]}>
        <View style={local.icon}><AppIcon name={item.icon} color={colors.primary} size={22} /></View>
        <Text style={local.label}>{item.label}</Text><Text style={local.description}>{!account && !['filter', 'ai', 'recruitments', 'pricing', 'terms', 'privacy', 'support'].includes(item.destination) ? '로그인 후 이용' : item.description}</Text>
      </MenuPressable>)}
    </View>)}
    {/* skn-501: 미확정 안내 시트 연결 보류
    <ServiceInformationSheet section={information} onClose={() => setInformation(null)} />
    */}
    <Button label="기능 소개 다시 보기" variant="secondary" onPress={() => setIntroOpen(true)} />
  </Page></View>
    <Modal visible={introOpen} animationType="slide" onRequestClose={closeIntroduction}>
      {introOpen && <SafeAreaProvider><View accessibilityViewIsModal style={{ flex: 1 }}><WelcomeScreen busy={false} error={null}
        onClose={closeIntroduction} onBrowse={closeIntroduction} onLogin={closeIntroduction} onSignup={closeIntroduction} /></View></SafeAreaProvider>}
    </Modal>
  </>
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
