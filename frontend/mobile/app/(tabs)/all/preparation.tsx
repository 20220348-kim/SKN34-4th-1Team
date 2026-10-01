import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { PreparationScreen } from '../../../src/screens/PreparationScreen'

export default function PreparationRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>()
  const router = useRouter()
  const selected = kind === 'reviews' ? 'reviews' : 'documents'
  return <><Stack.Screen options={{ title: selected === 'reviews' ? '중복 검토' : '신청 문서' }} />
    <PreparationScreen kind={selected} onLogin={() => router.push('/(tabs)/all/account')} /></>
}
