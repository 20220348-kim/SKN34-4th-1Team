import { useRouter } from 'expo-router'
import { Button, Notice, Page } from '../../src/ui'

/** OAuth credentials are verified and exchanged only by the pending AuthSession request. */
export default function OAuthCompleteRoute() {
  const router = useRouter()
  return <Page><Notice>로그인 화면에서 처리 결과를 확인해 주세요.</Notice>
    <Button label="내 정보로 이동" onPress={() => router.replace('/(tabs)/account')} />
  </Page>
}
