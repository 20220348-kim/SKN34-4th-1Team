import { useLoginFlow } from '../../../src/auth/loginFlow'
import { Alert, Linking, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getPartnerWebUrl, partnerErrorMessage } from '../../../src/api/partners'
import { useAuth } from '../../../src/auth/session'
import { AppIcon } from '../../../src/components/AppIcon'
import { CollaborationScreen } from '../../../src/screens/CollaborationScreen'
import { colors } from '../../../src/ui'

export default function CollaborationRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { view, box, mine } = useLocalSearchParams<{ view?: string; box?: string; mine?: string }>()
  return <>
    <CollaborationScreen view={view === 'box' ? 'box' : 'recruitments'}
      initialBox={box === 'sent' ? 'sent' : 'received'} mineOnly={mine === '1'}
      onViewChange={(next) => router.setParams({ view: next })}
      onOpenRecruitment={(id) => router.push({ pathname: '/partner/[id]', params: { id: String(id) } })}
      onLogin={() => requestLogin()} />
  </>
}

export function CollaborationHeaderAction() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { session } = useAuth()
  async function openCreate() {
    if (!session) { requestLogin({ message: '로그인하고 기업 정보를 확인한 뒤 모집글을 작성할 수 있어요.' }); return }
    if (session.account.company?.businessStatusCode !== '01') { router.push('/(tabs)/all/company'); return }
    try { await Linking.openURL(getPartnerWebUrl('/app/partners/new')) }
    catch (cause) { Alert.alert('모집글 작성 화면을 열지 못했습니다', partnerErrorMessage(cause)) }
  }
  return <Pressable accessibilityRole="button" accessibilityLabel="모집글 작성" onPress={() => void openCreate()}
    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
    <AppIcon name="pencil" color={colors.secondaryText} size={20} />
  </Pressable>
}
