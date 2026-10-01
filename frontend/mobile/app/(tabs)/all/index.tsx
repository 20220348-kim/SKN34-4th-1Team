import { useRouter } from 'expo-router'
import { MenuScreen, type MenuDestination } from '../../../src/screens/MenuScreen'

export default function MenuRoute() {
  const router = useRouter()
  function open(destination: MenuDestination) {
    switch (destination) {
      case 'account': router.push('/(tabs)/all/account'); break
      case 'company': router.push('/(tabs)/all/company'); break
      case 'settings': router.push('/(tabs)/all/settings'); break
      case 'filter': router.navigate({ pathname: '/(tabs)', params: { mode: 'filter' } }); break
      case 'ai': router.navigate({ pathname: '/(tabs)', params: { mode: 'ai' } }); break
      case 'saved': router.navigate('/(tabs)/saved'); break
      case 'report': router.navigate('/(tabs)/report'); break
      case 'documents': router.push({ pathname: '/(tabs)/all/preparation', params: { kind: 'documents' } }); break
      case 'reviews': router.push('/(tabs)/all/reviews'); break
      case 'recruitments': router.push('/(tabs)/all/collab'); break
      case 'received': router.push({ pathname: '/(tabs)/all/collab', params: { view: 'box', box: 'received' } }); break
      case 'sent': router.push({ pathname: '/(tabs)/all/collab', params: { view: 'box', box: 'sent' } }); break
      case 'mine': router.push({ pathname: '/(tabs)/all/collab', params: { mine: '1' } }); break
    }
  }
  return <MenuScreen onOpen={open} />
}
