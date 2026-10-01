import { useLocalSearchParams, useRouter } from 'expo-router'
import { SearchScreen } from '../../src/screens/SearchScreen'

export default function SearchRoute() {
  const router = useRouter()
  const { mode } = useLocalSearchParams<{ mode?: string }>()
  return <SearchScreen mode={mode === 'filter' ? 'filter' : 'ai'} onModeChange={(next) => router.setParams({ mode: next })}
    onOpenProgram={(identity) => router.push({ pathname: '/program', params: identity })}
    onLogin={() => router.push('/(tabs)/all/account')} />
}
