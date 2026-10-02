import { useLoginFlow } from '../../../src/auth/loginFlow'
import { Redirect, Stack, useLocalSearchParams } from 'expo-router'
import { PreparationScreen } from '../../../src/screens/PreparationScreen'

export default function PreparationRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>()
  const requestLogin = useLoginFlow()
  if (kind === 'reviews') return <Redirect href="/all/reviews" />
  return <><Stack.Screen options={{ title: '신청 문서' }} />
    <PreparationScreen kind="documents" onLogin={() => requestLogin()} /></>
}
