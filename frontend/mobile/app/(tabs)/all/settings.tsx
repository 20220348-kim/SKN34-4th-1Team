import { useLoginFlow } from '../../../src/auth/loginFlow'
import { useRouter } from 'expo-router'
import { DailyReportScreen } from '../../../src/screens/DailyReportScreen'

export default function ReportSettingsRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  return <DailyReportScreen settingsOnly onLogin={(mode) => requestLogin({ direct: true, mode: mode === 'signup' ? 'signup' : 'login' })}
    onCompany={() => router.push('/(tabs)/all/company')} onSearch={() => router.navigate('/(tabs)')}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} />
}
