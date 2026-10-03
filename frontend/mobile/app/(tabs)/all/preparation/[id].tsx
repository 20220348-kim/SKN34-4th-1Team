import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../../../src/auth/loginFlow'
import { ApplicationPreparationEditorScreen } from '../../../../src/screens/ApplicationPreparationEditorScreen'
import { parsePreparationId } from '../../../../src/api/applicationPreparation'
import { Notice, Page } from '../../../../src/ui'

export default function PreparationEditorRoute() {
  const router = useRouter(), requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ id?: string; question?: string }>(), id = parsePreparationId(params.id)
  if (!id) return <Page><Notice error>올바른 신청문서 주소가 아닙니다.</Notice></Page>
  return <ApplicationPreparationEditorScreen id={id} initialQuestion={typeof params.question === 'string' ? params.question : undefined} onLogin={() => requestLogin()}
    onReview={() => router.push({ pathname: '/all/preparation/[id]/review', params: { id: String(id) } })}
    onEditor={question => router.navigate({ pathname: '/all/preparation/[id]', params: { id: String(id), question } })}
    onDocuments={jobId => router.push({ pathname: '/all/preparation/[id]/documents', params: { id: String(id), ...(jobId ? { jobId: String(jobId) } : {}) } })}
    onReanalyze={identity => router.push({ pathname: '/all/preparation/new', params: identity })} />
}
