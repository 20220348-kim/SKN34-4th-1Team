import { useRouter } from 'expo-router'
import { CompanyScreen } from '../../../src/screens/CompanyScreen'

export default function CompanyRoute() {
  const router = useRouter()
  return <CompanyScreen onLogin={() => router.push('/(tabs)/all/account')} />
}
