import { View } from 'react-native'
import { AppIcon } from '../components/AppIcon'
import { Card, Page, Subtitle, Title, colors } from '../ui'

/** Visible tab destinations until the separately scoped report/collaboration features are connected. */
export function UpcomingFeatureScreen({ feature }: { feature: 'report' | 'collaboration' }) {
  const report = feature === 'report'
  return <Page>
    <Card>
      <View style={{ alignItems: 'center', gap: 12, paddingVertical: 24 }}>
        <AppIcon name={feature} size={32} color={colors.primary} />
        <Title>{report ? '맞춤 리포트를 준비하고 있어요' : '협업 공간을 준비하고 있어요'}</Title>
        <Subtitle>{report ? '리포트 조회와 수신 설정은 곧 이곳에서 제공할 예정이에요.'
          : '모집글과 제안함은 곧 이곳에서 제공할 예정이에요.'}</Subtitle>
      </View>
    </Card>
  </Page>
}
