import { ProgramReturnHeader, programReturnParams } from '../../../../src/components/ProgramReturnHeader'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../../../src/auth/loginFlow'
import { ApplicationPreparationNewScreen } from '../../../../src/screens/ApplicationPreparationNewScreen'

export default function NewPreparationRoute() {
  const router = useRouter(), requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ sourceCode?: string; sourceProgramId?: string; from?: string }>()
  const { sourceCode, sourceProgramId } = params
  const returnParams = programReturnParams(params)
  const initialProgram = typeof sourceCode === 'string' && typeof sourceProgramId === 'string' ? { sourceCode, sourceProgramId } : undefined
  return <><ProgramReturnHeader params={params} /><ApplicationPreparationNewScreen initialProgram={initialProgram} onLogin={() => requestLogin()}
    onList={() => router.navigate('/all/preparation')} onCreated={id => router.replace({ pathname: '/all/preparation/[id]', params: { ...returnParams, id: String(id) } })}
    onPendingDocument={id => router.push({ pathname: '/all/preparation/[id]/documents', params: { id: String(id) } })}
    onOpenProgram={identity => router.push({ pathname: '/program', params: identity })} /></>
}
