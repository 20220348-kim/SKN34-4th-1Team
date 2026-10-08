import { ProgramReturnHeader } from '../../../../src/components/ProgramReturnHeader'
import { useLoginFlow } from '../../../../src/auth/loginFlow'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { CombinationReviewEditorScreen, type CombinationReviewStep } from '../../../../src/screens/CombinationReviewScreens'
import { Notice, Page } from '../../../../src/ui'
const positiveId = (value: unknown) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
export default function ReviewRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ id?: string; runId?: string; step?: string; from?: string; sourceCode?: string; sourceProgramId?: string }>()
  const id = positiveId(params.id)
  const runId = params.runId === undefined ? undefined : positiveId(params.runId)
  if (!id || runId === null) return <Page><Notice error>올바른 검토·실행 주소가 아닙니다.</Notice></Page>
  const step = typeof params.step === 'string' && ['selection', 'participation', 'confirm', 'analysis'].includes(params.step) ? params.step as CombinationReviewStep : undefined
  return <><ProgramReturnHeader params={params} /><CombinationReviewEditorScreen id={id} runId={runId} initialStep={step} onLogin={() => requestLogin()}
    onStepChange={(_id, next) => router.setParams({ step: next })}
    onOpenProgram={identity => router.push({ pathname: '/program', params: identity })} /></>
}
