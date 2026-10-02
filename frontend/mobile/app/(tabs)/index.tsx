import { Tabs, useLocalSearchParams, useRouter } from 'expo-router'
import { SearchScreen } from '../../src/screens/SearchScreen'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { useAuth } from '../../src/auth/session'
import { Button } from '../../src/ui'

export default function SearchRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { status } = useAuth()
  const { mode } = useLocalSearchParams<{ mode?: string }>()
  return <><Tabs.Screen options={{ headerRight: status === 'signedOut' ? () => <Button label="로그인" variant="ghost" size="small"
    onPress={() => requestLogin({ direct: true })} /> : undefined }} />
    <SearchScreen mode={mode === 'filter' ? 'filter' : 'ai'} onModeChange={(next) => router.setParams({ mode: next })}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })}
    onLogin={requestLogin} /></>
}
