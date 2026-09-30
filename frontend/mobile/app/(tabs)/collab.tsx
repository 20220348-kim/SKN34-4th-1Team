import { useCallback, useState } from 'react'
import { Alert, Linking, Pressable } from 'react-native'
import { Tabs, useLocalSearchParams, useRouter } from 'expo-router'
import { getPartnerWebUrl, partnerErrorMessage } from '../../src/api/partners'
import { useAuth } from '../../src/auth/session'
import { AppIcon } from '../../src/components/AppIcon'
import { CollaborationScreen } from '../../src/screens/CollaborationScreen'
import { colors } from '../../src/ui'

export default function CollaborationRoute() {
  const router = useRouter()
  const { view } = useLocalSearchParams<{ view?: string }>()
  const { session, status } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const [pending, setPending] = useState<{ token: string | null; count: number }>({ token: null, count: 0 })
  const setPendingCount = useCallback((count: number) => setPending((current) => current.token === token && current.count === count
    ? current : { token, count }), [token])
  return <>
    <Tabs.Screen options={{ tabBarBadge: pending.token === token ? pending.count || undefined : undefined }} />
    <CollaborationScreen view={view === 'box' ? 'box' : 'recruitments'}
      onViewChange={(next) => router.setParams({ view: next })} onPendingCount={setPendingCount}
      onOpenRecruitment={(id) => router.push({ pathname: '/partner/[id]', params: { id: String(id) } })}
      onLogin={() => router.navigate('/(tabs)/account')} />
  </>
}

export function CollaborationHeaderAction() {
  const router = useRouter()
  const { session } = useAuth()
  async function openCreate() {
    if (!session) { router.navigate('/(tabs)/account'); return }
    if (session.account.company?.businessStatusCode !== '01') { router.push('/company'); return }
    try { await Linking.openURL(getPartnerWebUrl('/app/partners/new')) }
    catch (cause) { Alert.alert('모집글 작성 화면을 열지 못했습니다', partnerErrorMessage(cause)) }
  }
  return <Pressable accessibilityRole="button" accessibilityLabel="모집글 작성" onPress={() => void openCreate()}
    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
    <AppIcon name="pencil" color={colors.secondaryText} size={20} />
  </Pressable>
}
