import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountScreen } from '../../../src/screens/AccountScreen'
import { useAuth } from '../../../src/auth/session'

export default function AccountRoute() {
  const router = useRouter()
  const { status } = useAuth()
  const previousStatus = useRef(status)
  const [focused, setFocused] = useState(false)
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false) }, []))
  useEffect(() => {
    if (previousStatus.current === 'signedOut' && status === 'signedIn') router.navigate('/(tabs)')
    previousStatus.current = status
  }, [status, router])
  return <AccountScreen usageEnabled={focused} onCompany={() => router.push('/(tabs)/all/company')}
    onSettings={() => router.push('/(tabs)/all/settings')} />
}
