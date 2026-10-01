import { Pressable } from 'react-native'
import { useRouter } from 'expo-router'
import { AppIcon } from '../../src/components/AppIcon'
import { DailyReportScreen } from '../../src/screens/DailyReportScreen'
import { colors } from '../../src/ui'

export default function ReportRoute() {
  const router = useRouter()
  return <DailyReportScreen onLogin={() => router.navigate('/(tabs)/all/account')}
    onCompany={() => router.push('/(tabs)/all/company')} onSearch={() => router.navigate('/(tabs)')}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })} />
}

export function ReportHeaderAction() {
  const router = useRouter()
  return <Pressable accessibilityRole="button" accessibilityLabel="기업 정보 수정" onPress={() => router.push('/(tabs)/all/company')}
    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
    <AppIcon name="pencil" color={colors.secondaryText} size={20} />
  </Pressable>
}
