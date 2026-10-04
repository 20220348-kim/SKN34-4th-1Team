import { useLoginFlow } from '../../src/auth/loginFlow'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { RecruitmentDetailScreen } from '../../src/screens/RecruitmentDetailScreen'
import { Notice, Page } from '../../src/ui'

export default function RecruitmentRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { id } = useLocalSearchParams<{ id: string }>()
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return <Page><Notice error>모집글 링크가 올바르지 않습니다.</Notice></Page>
  }
  return <RecruitmentDetailScreen id={Number(id)}
    onEdit={() => router.push({ pathname: '/partner/edit', params: { id } })}
    onLogin={() => requestLogin()} onCompany={() => router.push('/(tabs)/all/company')}
    onProgram={(identity) => router.push({ pathname: '/program', params: identity })}
    onInbox={() => router.navigate({ pathname: '/(tabs)/all/collab', params: { view: 'box' } })} />
}
