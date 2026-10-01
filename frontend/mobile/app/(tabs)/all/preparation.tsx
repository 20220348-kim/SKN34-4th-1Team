import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { PreparationScreen } from '../../../src/screens/PreparationScreen'

export default function PreparationRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>()
  const router = useRouter()
  if (kind === 'reviews') return <Redirect href="/all/reviews" />
  return <><Stack.Screen options={{ title: '신청 문서' }} />
    <PreparationScreen kind="documents" onLogin={() => router.push('/(tabs)/all/account')} /></>
}
