import { Redirect, useLocalSearchParams } from 'expo-router'

/** Keep existing collaboration links while moving the destination inside All. */
export default function LegacyCollaborationRoute() {
  const { view, box, mine } = useLocalSearchParams<{ view?: string; box?: string; mine?: string }>()
  return <Redirect href={{ pathname: '/(tabs)/all/collab', params: { view: view === 'box' ? 'box' : 'recruitments',
    box: box === 'sent' ? 'sent' : 'received', mine: mine === '1' ? '1' : '0' } }} />
}
