import { Redirect, useLocalSearchParams } from 'expo-router'
import { useRouter } from 'expo-router'
import { useAuth } from '../../src/auth/session'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { CollaborationScreen } from '../../src/screens/CollaborationScreen'

/** Keep existing collaboration links while moving the destination inside All. */
export default function CollaborationTabRoute() {
  const { status } = useAuth()
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { view, box, mine } = useLocalSearchParams<{ view?: string; box?: string; mine?: string }>()
  if (status !== 'signedIn') return <CollaborationScreen view={view === 'box' ? 'box' : 'recruitments'}
    initialBox={box === 'sent' ? 'sent' : 'received'} mineOnly={mine === '1'} onViewChange={next => router.setParams({ view: next })}
    onOpenRecruitment={id => router.push({ pathname: '/partner/[id]', params: { id: String(id) } })} onLogin={() => requestLogin()} />
  return <Redirect href={{ pathname: '/(tabs)/all/collab', params: { view: view === 'box' ? 'box' : 'recruitments',
    box: box === 'sent' ? 'sent' : 'received', mine: mine === '1' ? '1' : '0' } }} />
}
