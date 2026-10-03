import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../../../../src/auth/loginFlow'
import { ApplicationDocumentScreen } from '../../../../../src/screens/ApplicationDocumentScreen'
import { parsePreparationId } from '../../../../../src/api/applicationPreparation'
import { Notice, Page } from '../../../../../src/ui'

export default function PreparationDocumentRoute() {
  const router = useRouter(), requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ id?: string; jobId?: string }>(), id = parsePreparationId(params.id)
  const jobId = params.jobId === undefined ? undefined : parsePreparationId(params.jobId)
  if (!id || jobId === null) return <Page><Notice error>올바른 신청문서·생성 작업 주소가 아닙니다.</Notice></Page>
  return <ApplicationDocumentScreen id={id} jobId={jobId} onLogin={() => requestLogin()}
    onEditor={() => router.navigate({ pathname: '/all/preparation/[id]', params: { id: String(id) } })}
    onOnline={() => router.push({ pathname: '/all/preparation/[id]/online', params: { id: String(id) } })}
    onList={() => router.navigate('/all/preparation')}
    onOpenPending={pendingId => router.push({ pathname: '/all/preparation/[id]/documents', params: { id: String(pendingId) } })}
    onReanalyze={identity => router.push({ pathname: '/all/preparation/new', params: identity })} />
}
