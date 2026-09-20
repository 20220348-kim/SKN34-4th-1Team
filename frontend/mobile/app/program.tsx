import { useLocalSearchParams, useRouter } from 'expo-router'
import { ProgramScreen } from '../src/screens/ProgramScreen'
import { useAuth } from '../src/auth/session'
import { Notice, Page } from '../src/ui'

export default function ProgramRoute() {
  const { sourceCode, sourceProgramId } = useLocalSearchParams<{ sourceCode: string; sourceProgramId: string }>()
  const router = useRouter()
  const { session } = useAuth()
  if (typeof sourceCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(sourceCode)
    || typeof sourceProgramId !== 'string' || !sourceProgramId || sourceProgramId.length > 500) {
    return <Page><Notice error>공고 링크가 올바르지 않습니다.</Notice></Page>
  }
  return <ProgramScreen key={`${session?.account.email ?? 'guest'}:${sourceCode}:${sourceProgramId}`} identity={{ sourceCode, sourceProgramId }} onLogin={() => router.push('/(tabs)/account')} />
}
