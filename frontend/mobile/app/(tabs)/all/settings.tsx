import { useLoginFlow } from '../../../src/auth/loginFlow'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable } from 'react-native'
import { AppIcon } from '../../../src/components/AppIcon'
import { colors } from '../../../src/ui'
import { DailyReportScreen } from '../../../src/screens/DailyReportScreen'

export default function ReportSettingsRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const params = useLocalSearchParams<{ from?: string; reportId?: string }>()
  return <><Stack.Screen options={{ headerLeft: params.from === 'report' ? () => <Pressable accessibilityRole="button" accessibilityLabel="리포트로 돌아가기"
    onPress={() => router.navigate({ pathname: '/(tabs)/report', params: typeof params.reportId === 'string' ? { reportId: params.reportId } : {} })}
    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><AppIcon name="back" color={colors.text} size={23} /></Pressable> : undefined }} />
    <DailyReportScreen settingsOnly onLogin={(mode) => requestLogin({ direct: true, mode: mode === 'signup' ? 'signup' : 'login' })}
    onCompany={() => router.push('/(tabs)/all/company')} onSearch={() => router.navigate('/(tabs)')}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} /></>
}
