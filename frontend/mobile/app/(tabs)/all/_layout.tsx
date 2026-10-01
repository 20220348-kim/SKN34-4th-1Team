import { Stack } from 'expo-router'
import { CollaborationHeaderAction } from './collab'
import { colors } from '../../../src/ui'

export default function AllLayout() {
  return <Stack screenOptions={{ headerTintColor: colors.text, headerTitleAlign: 'left', headerBackTitle: '전체',
    headerTitleStyle: { fontSize: 18, fontWeight: '700' }, headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.surface }, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="account" options={{ title: '내 정보' }} />
    <Stack.Screen name="company" options={{ title: '기업 정보' }} />
    <Stack.Screen name="settings" options={{ title: '리포트 수신 설정' }} />
    <Stack.Screen name="preparation" options={{ title: '신청 준비' }} />
    <Stack.Screen name="reviews/index" options={{ title: '중복 검토' }} />
    <Stack.Screen name="reviews/new" options={{ title: '중복 지원·수혜' }} />
    <Stack.Screen name="reviews/[id]" options={{ title: '중복 지원·수혜' }} />
    <Stack.Screen name="collab" options={{ title: '협업', headerRight: () => <CollaborationHeaderAction /> }} />
  </Stack>
}
