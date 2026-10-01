import { useRouter } from 'expo-router'
import { DailyReportScreen } from '../../../src/screens/DailyReportScreen'

export default function ReportSettingsRoute() {
  const router = useRouter()
  return <DailyReportScreen settingsOnly onLogin={() => router.push('/(tabs)/all/account')}
    onCompany={() => router.push('/(tabs)/all/company')} onSearch={() => router.navigate('/(tabs)')}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} />
}
