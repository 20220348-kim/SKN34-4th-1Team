import { useLoginFlow } from '../../../../src/auth/loginFlow'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { CombinationReviewEditorScreen } from '../../../../src/screens/CombinationReviewScreens'
import { Notice, Page } from '../../../../src/ui'
const positiveId = (value: unknown) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
export default function ReviewRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ id?: string; runId?: string }>()
  const id = positiveId(params.id)
  const runId = params.runId === undefined ? undefined : positiveId(params.runId)
  if (!id || runId === null) return <Page><Notice error>올바른 검토·실행 주소가 아닙니다.</Notice></Page>
  return <CombinationReviewEditorScreen id={id} runId={runId} onLogin={() => requestLogin()}
    onList={() => router.navigate('/all/reviews')} onOpenProgram={identity => router.push({ pathname: '/program', params: identity })} />
}
