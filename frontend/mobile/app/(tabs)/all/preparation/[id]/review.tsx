import { programReturnParams } from '../../../../../src/components/ProgramReturnHeader'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../../../../src/auth/loginFlow'
import { ApplicationPreparationEditorScreen } from '../../../../../src/screens/ApplicationPreparationEditorScreen'
import { parsePreparationId } from '../../../../../src/api/applicationPreparation'
import { Notice, Page } from '../../../../../src/ui'

export default function PreparationReviewRoute() {
  const router = useRouter(), requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ id?: string; from?: string; sourceCode?: string; sourceProgramId?: string }>(), id = parsePreparationId(params.id)
  if (!id) return <Page><Notice error>올바른 신청문서 주소가 아닙니다.</Notice></Page>
  const returnParams = programReturnParams(params)
  return <ApplicationPreparationEditorScreen id={id} reviewing onLogin={() => requestLogin()} onReview={() => undefined}
    onEditor={question => router.navigate({ pathname: '/all/preparation/[id]', params: { ...returnParams, id: String(id), question } })}
    onDocuments={jobId => router.push({ pathname: '/all/preparation/[id]/documents', params: { ...returnParams, id: String(id), ...(jobId ? { jobId: String(jobId) } : {}) } })}
    onReanalyze={identity => router.push({ pathname: '/all/preparation/new', params: identity })} />
}
