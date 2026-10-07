import { ProgramReturnHeader, programReturnParams } from '../../../../src/components/ProgramReturnHeader'
import { useLoginFlow } from '../../../../src/auth/loginFlow'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { catalogSourceCodes } from '@govbiz/shared/domain/entities/SupportProgramCatalog'
import { CombinationReviewEditorScreen } from '../../../../src/screens/CombinationReviewScreens'
export default function NewReviewRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ sourceCode?: string; sourceProgramId?: string; from?: string }>()
  const { sourceCode, sourceProgramId } = params
  const returnParams = programReturnParams(params)
  const initialProgram = typeof sourceCode === 'string' && sourceCode && catalogSourceCodes.some(code => code === sourceCode)
    && typeof sourceProgramId === 'string' && sourceProgramId.length > 0 && sourceProgramId.length <= 255 ? { sourceCode, sourceProgramId } : undefined
  return <><ProgramReturnHeader params={params} /><CombinationReviewEditorScreen id={null} initialProgram={initialProgram} onLogin={() => requestLogin()}
    onStepChange={(id, step) => router.replace({ pathname: '/all/reviews/[id]', params: { ...returnParams, id: String(id), step } })}
    onList={() => router.navigate('/all/reviews')} onOpenProgram={identity => router.push({ pathname: '/program', params: identity })} /></>
}
