import { useRouter } from 'expo-router'
import { MenuScreen, type MenuDestination } from '../../../src/screens/MenuScreen'
import { useAuth } from '../../../src/auth/session'
import { useLoginFlow } from '../../../src/auth/loginFlow'

export default function MenuRoute() {
  const router = useRouter()
  const { status } = useAuth()
  const requestLogin = useLoginFlow()
  function navigate(destination: MenuDestination, signedIn: boolean) {
    switch (destination) {
      case 'account': router.push('/(tabs)/all/account'); break
      case 'company': router.push('/(tabs)/all/company'); break
      case 'settings': router.push('/(tabs)/all/settings'); break
      case 'pricing':
        if (signedIn) router.push('/(tabs)/all/pricing')
        else router.navigate('/(tabs)/pricing')
        break
      case 'filter': router.navigate({ pathname: '/(tabs)', params: { mode: 'filter' } }); break
      case 'ai': router.navigate({ pathname: '/(tabs)', params: { mode: 'ai' } }); break
      case 'saved': router.navigate('/(tabs)/saved'); break
      case 'report': router.navigate('/(tabs)/report'); break
      case 'documents': router.push({ pathname: '/(tabs)/all/preparation', params: { kind: 'documents' } }); break
      case 'reviews': router.push('/(tabs)/all/reviews'); break
      case 'recruitments': router.navigate({ pathname: signedIn ? '/(tabs)/all/collab' : '/(tabs)/collab', params: { management: '0', view: 'recruitments', mine: '0' } }); break
      case 'partners': router.push({ pathname: '/(tabs)/all/collab', params: { management: '1', view: 'box', box: 'received', mine: '0' } }); break
      case 'received': router.push({ pathname: '/(tabs)/all/collab', params: { view: 'box', box: 'received' } }); break
      case 'sent': router.push({ pathname: '/(tabs)/all/collab', params: { view: 'box', box: 'sent' } }); break
      case 'mine': router.push({ pathname: '/(tabs)/all/collab', params: { mine: '1' } }); break
    }
  }
  function open(destination: MenuDestination) {
    if (status === 'signedOut' && !['filter', 'ai', 'recruitments', 'pricing'].includes(destination)) {
      requestLogin({ direct: destination === 'account', message: '이 기능은 로그인 후 이용할 수 있어요.',
        onAuthenticated: () => navigate(destination, true) })
      return
    }
    navigate(destination, status === 'signedIn')
  }
  return <MenuScreen onOpen={open} />
}
