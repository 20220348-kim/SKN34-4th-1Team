import { useNavigation, useRouter } from 'expo-router'
import { CommonActions } from 'expo-router/react-navigation'
import { useAuth } from '../../src/auth/session'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { PricingScreen } from '../../src/screens/PricingScreen'

export default function PricingRoute() {
  const router = useRouter()
  const tabs = useNavigation('/(tabs)')
  const { status } = useAuth()
  const requestLogin = useLoginFlow()
  function openPlus() {
    if (status === 'signedIn') router.navigate('/(tabs)/saved')
    else requestLogin({ message: '플러스 기능은 정식 출시 전까지 회원에게 무료로 제공해요.',
      onAuthenticated: () => router.navigate('/(tabs)/saved') })
  }
  return <PricingScreen onSearch={() => tabs.dispatch(CommonActions.navigate({ name: 'index', merge: true }))} onPlus={openPlus}
    plusDisabled={status !== 'signedIn' && status !== 'signedOut'} />
}
