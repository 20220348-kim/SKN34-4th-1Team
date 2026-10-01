import { useRouter } from 'expo-router'
import { AccountScreen } from '../../../src/screens/AccountScreen'

export default function AccountRoute() {
  const router = useRouter()
  return <AccountScreen onCompany={() => router.push('/(tabs)/all/company')}
    onSettings={() => router.push('/(tabs)/all/settings')} />
}
