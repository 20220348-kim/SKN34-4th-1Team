import { seekingPartnerRoles, type PartnerRole } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import { regionNamesWithoutNationwide } from '@govbiz/shared/domain/entities/Region'
import { useLoginFlow } from '../../../src/auth/loginFlow'
import { screenTitles } from '@govbiz/shared/design/screenTitles'
import { Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useAuth } from '../../../src/auth/session'
import { AppIcon } from '../../../src/components/AppIcon'
import { CollaborationScreen } from '../../../src/screens/CollaborationScreen'
import { colors } from '../../../src/ui'

export default function CollaborationRoute() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { view, box, mine, management, keyword, seekingRole, region } = useLocalSearchParams<{ view?: string; box?: string; mine?: string; management?: string; keyword?: string; seekingRole?: string | string[]; region?: string | string[] }>()
  const values = (value: string | string[] | undefined) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).flatMap(item => item.split(','))
  const initialQuery = { keyword: keyword ?? '', seekingRoles: values(seekingRole).filter((role): role is PartnerRole => seekingPartnerRoles.some(known => known === role)),
    regions: values(region).filter(value => regionNamesWithoutNationwide.some(known => known === value)) }
  const managing = management === '1'
  return <>
    <Stack.Screen options={{ title: managing ? screenTitles.partnerManagement : screenTitles.publicPartners, headerRight: managing ? () => null : () => <CollaborationHeaderAction /> }} />
    <CollaborationScreen key={JSON.stringify(initialQuery)} initialQuery={initialQuery} management={managing} onManagementTabChange={tab => router.setParams({
      view: tab === 'mine' ? 'recruitments' : 'box', box: tab === 'mine' ? box ?? 'received' : tab, mine: tab === 'mine' ? '1' : '0',
    })} view={managing ? mine === '1' ? 'recruitments' : 'box' : view === 'box' ? 'box' : 'recruitments'}
      initialBox={box === 'sent' ? 'sent' : 'received'} mineOnly={mine === '1'}
      onViewChange={(next) => router.setParams({ view: next })}
      onOpenRecruitment={(id) => router.push({ pathname: '/partner/[id]', params: { id: String(id) } })}
      onLogin={() => requestLogin()} />
  </>
}

export function CollaborationHeaderAction() {
  const router = useRouter()
  const requestLogin = useLoginFlow()
  const { status } = useAuth()
  function openCreate() {
    requestLogin({ message: '로그인하고 기업 정보를 확인한 뒤 모집글을 작성할 수 있어요.',
      onAuthenticated: (verified) => {
        if (verified.account.company?.businessStatusCode !== '01') { router.push('/(tabs)/all/company'); return }
        router.push('/partner/new')
      } })
  }
  return <Pressable accessibilityRole="button" accessibilityLabel="모집글 작성" onPress={openCreate}
    disabled={status === 'loading' || status === 'unavailable'}
    accessibilityState={{ disabled: status === 'loading' || status === 'unavailable' }}
    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
    <AppIcon name="pencil" color={colors.secondaryText} size={20} />
  </Pressable>
}
