import { useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { AccountScreen } from '../../../src/screens/AccountScreen'
import { useAuth } from '../../../src/auth/session'

export default function AccountRoute() {
  const router = useRouter()
  const { status } = useAuth()
  const previousStatus = useRef(status)
  useEffect(() => {
    if (previousStatus.current === 'signedOut' && status === 'signedIn') router.navigate('/(tabs)')
    previousStatus.current = status
  }, [status, router])
  return <AccountScreen onCompany={() => router.push('/(tabs)/all/company')}
    onSettings={() => router.push('/(tabs)/all/settings')} />
}
