import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AuthProvider } from '../src/auth/session'
import { AppEntryGate } from '../src/auth/AppEntryGate'
import { LoginFlowProvider } from '../src/auth/loginFlow'
import { DailyReportPushProvider } from '../src/notifications/DailyReportPushProvider'
import { Button, Notice, Page, Title, colors } from '../src/ui'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not log credentials or API responses. */ }
  render() {
    if (this.state.error) return <Page headerless><Title>앱을 열지 못했습니다</Title>
      <Notice error>앱 설정을 확인하거나 잠시 후 다시 실행해 주세요.</Notice>
      <Button label="다시 시도" onPress={() => this.setState({ error: false })} />
    </Page>
    return this.props.children
  }
}

export default function RootLayout() {
  return <SafeAreaProvider><StatusBar style="dark" /><AppErrorBoundary><AuthProvider><DailyReportPushProvider><LoginFlowProvider><AppEntryGate>
    <Stack screenOptions={{ headerTintColor: colors.text, headerTitleAlign: 'left', headerTitleStyle: { fontSize: 17, fontWeight: '600' },
      headerStyle: { backgroundColor: colors.surface }, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="program" options={{ title: '공고 상세' }} />
      <Stack.Screen name="partner/new" options={{ title: '모집글 작성' }} />
      <Stack.Screen name="partner/[id]" options={{ title: '모집글 상세' }} />
      <Stack.Screen name="company" options={{ title: '기업 프로필' }} />
      <Stack.Screen name="oauth/complete" options={{ title: '로그인' }} />
    </Stack>
  </AppEntryGate></LoginFlowProvider></DailyReportPushProvider></AuthProvider></AppErrorBoundary></SafeAreaProvider>
}
