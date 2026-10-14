import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { RecruitmentCreateScreen } from '../../src/screens/RecruitmentCreateScreen'

export default function RecruitmentCreateRoute() {
  const { sourceCode, sourceProgramId } = useLocalSearchParams<{ sourceCode?: string; sourceProgramId?: string }>()
  const router = useRouter()
  const requestLogin = useLoginFlow()
  return <RecruitmentCreateScreen initialProgram={sourceCode && sourceProgramId ? { sourceCode, sourceProgramId } : undefined} onLogin={() => requestLogin()}
    onCompany={() => router.push('/(tabs)/all/company')}
    onSavedPrograms={() => router.push('/(tabs)/saved')}
    onCreated={(id) => router.replace({ pathname: '/partner/[id]', params: { id: String(id) } })}
    onCancel={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/all/collab')} />
}
