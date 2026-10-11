import { useCallback, useState } from 'react'
import { useFocusEffect, useNavigation, useRouter } from 'expo-router'
import { CommonActions } from 'expo-router/react-navigation'
import { useAuth } from '../../src/auth/session'
import { usePlanUsage } from '../../src/components/PlanUsage'
import { PricingScreen } from '../../src/screens/PricingScreen'

export default function PricingRoute() {
  const tabs = useNavigation('/(tabs)')
  const router = useRouter()
  const { status, session } = useAuth()
  const [focused, setFocused] = useState(false)
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))
  const signedIn = status === 'signedIn'
  const { usage, loading, failed, reload } = usePlanUsage(session?.accessToken, signedIn && focused)
  return <PricingScreen key={signedIn ? session?.account.email : 'public'}
    onSearch={() => tabs.dispatch(CommonActions.navigate({ name: 'index', merge: true }))}
    signedIn={signedIn} usage={signedIn ? usage : null} loading={signedIn && (loading || (!usage && !failed))}
    failed={signedIn && failed} onRetry={reload} onAccount={() => router.push('/(tabs)/all/account')} />
}
