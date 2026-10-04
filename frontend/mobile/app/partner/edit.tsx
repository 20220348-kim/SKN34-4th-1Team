import { useLocalSearchParams, useRouter } from 'expo-router'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { RecruitmentCreateScreen } from '../../src/screens/RecruitmentCreateScreen'
import { Notice, Page } from '../../src/ui'

export default function RecruitmentEditRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { id } = useLocalSearchParams<{ id?: string }>()
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    return <Page><Notice error>모집글 수정 링크가 올바르지 않습니다.</Notice></Page>
  }
  const returnToDetail = () => router.dismissTo({ pathname: '/partner/[id]', params: { id } })
  return <RecruitmentCreateScreen recruitmentId={Number(id)} onLogin={() => requestLogin()}
    onCompany={() => router.push('/(tabs)/all/company')}
    onSavedPrograms={() => router.push('/(tabs)/saved')}
    onCreated={returnToDetail} onCancel={returnToDetail} />
}
