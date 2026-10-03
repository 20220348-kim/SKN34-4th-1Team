import { useLoginFlow } from '../../../src/auth/loginFlow'
import { Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
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
  const { status } = useAuth()
  function openCreate() {
    requestLogin({ message: '로그인하고 기업 정보를 확인한 뒤 모집글을 작성할 수 있어요.',
      onAuthenticated: (verified) => {
        if (verified.account.company?.businessStatusCode !== '01') { router.push('/(tabs)/all/company'); return }
        router.push('/partner/new')
      } })
  }
  return <Pressable accessibilityRole="button" accessibilityLabel="모집글 작성" onPress={openCreate}
    disabled={status === 'loading' || status === 'unavailable'}
    accessibilityState={{ disabled: status === 'loading' || status === 'unavailable' }}
    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
    <AppIcon name="pencil" color={colors.secondaryText} size={20} />
  </Pressable>
}
