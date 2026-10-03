import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../../../../src/auth/loginFlow'
import { ApplicationOnlineInputScreen } from '../../../../../src/screens/ApplicationOnlineInputScreen'
import { parsePreparationId } from '../../../../../src/api/applicationPreparation'
import { Notice, Page } from '../../../../../src/ui'

export default function PreparationOnlineRoute() {
  const router = useRouter(), requestLogin = useLoginFlow()
  const { id: value } = useLocalSearchParams<{ id?: string }>(), id = parsePreparationId(value)
  if (!id) return <Page><Notice error>올바른 신청문서 주소가 아닙니다.</Notice></Page>
  return <ApplicationOnlineInputScreen id={id} onLogin={() => requestLogin()} onEditor={() => router.navigate({ pathname: '/all/preparation/[id]', params: { id: String(id) } })} />
}
