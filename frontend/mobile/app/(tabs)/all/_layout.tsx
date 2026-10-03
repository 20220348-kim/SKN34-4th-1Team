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
    <Stack.Screen name="preparation/new" options={{ title: '공고·양식 선택' }} />
    <Stack.Screen name="preparation/[id]" options={{ title: '답변 작성' }} />
    <Stack.Screen name="preparation/[id]/review" options={{ title: '답변 검토' }} />
    <Stack.Screen name="preparation/[id]/documents" options={{ title: '문서 결과' }} />
    <Stack.Screen name="preparation/[id]/online" options={{ title: '온라인 신청 안내' }} />
    <Stack.Screen name="reviews/index" options={{ title: '중복 검토' }} />
    <Stack.Screen name="reviews/new" options={{ title: '중복 지원·수혜' }} />
    <Stack.Screen name="reviews/[id]" options={{ title: '중복 지원·수혜' }} />
    <Stack.Screen name="collab" options={{ title: '협업', headerRight: () => <CollaborationHeaderAction /> }} />
  </Stack>
}
