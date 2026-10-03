import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Button, Card, Notice, Page, colors, styles } from '../ui'
import { useAuth } from '../auth/session'

export function PreparationAccess({ onLogin }: { onLogin(): void }) {
  const { status, refreshSession } = useAuth()
  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" color={colors.primary} /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했어요.</Notice><Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  return <Page><Card><Text style={styles.heading}>신청 준비를 이어가세요</Text><Text style={styles.muted}>로그인하면 작성한 답변과 신청문서를 웹과 앱에서 함께 확인할 수 있어요.</Text><Button label="로그인하고 시작하기" onPress={onLogin} /></Card></Page>
}
export function PreparationSteps({ active }: { active: 0 | 1 | 2 }) {
  return <View style={local.steps}>{['공고·양식', '답변 작성', '검토·생성'].map((label, index) => <Text key={label}
    style={[local.step, active === index && local.current]}>{index + 1}. {label}</Text>)}</View>
}
export const preparationUi = StyleSheet.create({
  footer: { paddingHorizontal: 16, paddingTop: 12, gap: 8, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  scroll: { padding: 16, gap: 12 },
  selected: { backgroundColor: colors.soft, borderRadius: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  textAction: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
})
const local = StyleSheet.create({ steps: { flexDirection: 'row', gap: 6 },
  step: { flex: 1, textAlign: 'center', fontSize: 12, lineHeight: 24, color: colors.muted, borderBottomWidth: 2, borderBottomColor: colors.border, paddingBottom: 6 },
  current: { color: colors.primary, borderBottomColor: colors.primary, fontWeight: '600' },
})
