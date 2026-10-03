import { useLoginFlow } from '../../../src/auth/loginFlow'
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, Text } from 'react-native'
import { ApplicationDocumentsListScreen } from '../../../src/screens/ApplicationDocumentsListScreen'
import { colors } from '../../../src/ui'

export default function PreparationRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>()
  const requestLogin = useLoginFlow()
  const router = useRouter()
  const onNew = (identity?: { sourceCode: string; sourceProgramId: string }) => requestLogin({ onAuthenticated: () => router.push({ pathname: '/all/preparation/new', params: identity }) })
  if (kind === 'reviews') return <Redirect href="/all/reviews" />
  return <><Stack.Screen options={{ title: '신청 문서', headerRight: () => <Pressable accessibilityRole="button" accessibilityLabel="새 신청 ＋" onPress={() => onNew()} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }}>
    <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>새 신청 ＋</Text></Pressable> }} />
    <ApplicationDocumentsListScreen onLogin={() => requestLogin()} onNew={onNew}
      onOpen={(id, documents) => router.push(documents ? { pathname: '/all/preparation/[id]/documents', params: { id: String(id) } } : { pathname: '/all/preparation/[id]', params: { id: String(id) } })} /></>
}
