import { useNavigation } from 'expo-router'
import { CommonActions } from 'expo-router/react-navigation'
import { useAuth } from '../../src/auth/session'
import { usePlanUsage } from '../../src/components/PlanUsage'
import { PricingScreen } from '../../src/screens/PricingScreen'

export default function PricingRoute() {
  const tabs = useNavigation('/(tabs)')
  const { status, session } = useAuth()
  // 로그인했으면 지금 요금제만 읽어 그 요금제를 강조합니다. 로그인 전에는 읽지 않습니다.
  const { usage } = usePlanUsage(session?.accessToken, status === 'signedIn')
  return <PricingScreen onSearch={() => tabs.dispatch(CommonActions.navigate({ name: 'index', merge: true }))}
    currentPlan={status === 'signedIn' ? usage?.plan ?? null : null} />
}
