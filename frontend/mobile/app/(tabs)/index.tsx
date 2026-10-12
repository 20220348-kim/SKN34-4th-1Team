import { Tabs, useLocalSearchParams, useRouter } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { SearchScreen } from '../../src/screens/SearchScreen'
import { useLoginFlow } from '../../src/auth/loginFlow'
import { useAuth } from '../../src/auth/session'
import { Button } from '../../src/ui'
import { useAssistant } from '../../src/assistant/context'

export default function SearchRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { status } = useAuth()
  const assistant = useAssistant()
  const headerHeight = useHeaderHeight()
  const { mode } = useLocalSearchParams<{ mode?: string }>()
  return <><Tabs.Screen options={{ headerRight: status === 'signedOut' ? () => <Button label="로그인" variant="ghost" size="small"
    onPress={() => requestLogin({ direct: true })} /> : undefined }} />
    <SearchScreen mode={mode === 'filter' ? 'filter' : 'ai'} headerHeight={headerHeight} onModeChange={(next) => router.setParams({ mode: next })}
    assistantDraft={assistant.searchDraft} onDraftConsumed={assistant.consumeSearchDraft}
    onOpenProgram={(identity, options) => router.push({ pathname: '/program', params: options?.ask ? { ...identity, ask: '1' } : identity })}
    onLogin={requestLogin} /></>
}
