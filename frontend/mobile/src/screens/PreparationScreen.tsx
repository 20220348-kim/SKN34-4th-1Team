import { ActivityIndicator, Text } from 'react-native'
import { useAuth } from '../auth/session'
import { PreparationRow, ReviewRow } from '../components/PreparationRows'
import { usePreparationWorkspace } from '../components/usePreparationWorkspace'
import { Button, Notice, Page, colors, styles } from '../ui'

export function PreparationScreen({ kind, onLogin }: { kind: 'documents' | 'reviews'; onLogin(): void }) {
  const { status, session, refreshSession } = useAuth()
  const token = status === 'signedIn' ? session?.accessToken ?? null : null
  const workspace = usePreparationWorkspace(token)
  if (status === 'loading') return <Page><ActivityIndicator accessibilityLabel="로그인 상태 확인 중" /></Page>
  if (status === 'unavailable') return <Page><Notice error>로그인 상태를 확인하지 못했습니다.</Notice>
    <Button label="다시 확인" onPress={() => void refreshSession()} /></Page>
  if (!token) return <Page><Notice>로그인하면 신청 문서와 중복 검토를 확인할 수 있어요.</Notice>
    <Button label="로그인하기" onPress={onLogin} /></Page>
  const error = kind === 'documents' ? workspace.preparationError : workspace.reviewError
  const items = kind === 'documents' ? workspace.preparations : workspace.reviews
  return <Page refreshing={workspace.loading} onRefresh={workspace.refresh}>
    <Text style={styles.heading}>{kind === 'documents' ? '신청 문서' : '중복 검토'}{items === null ? '' : ` ${items.length}건`}</Text>
    {error && <><Notice error>{error}</Notice><Button label="다시 확인" onPress={workspace.refresh} /></>}
    {workspace.loading && items === null && <ActivityIndicator accessibilityLabel="준비 작업 불러오는 중" color={colors.primary} />}
    {kind === 'documents' ? workspace.preparations?.map((item) => <PreparationRow key={item.id} item={item} />)
      : workspace.reviews?.map((item) => <ReviewRow key={item.review.id} item={item} />)}
    {!workspace.loading && !error && items?.length === 0 && <Notice>{kind === 'documents' ? '아직 신청 문서가 없습니다.' : '아직 중복 검토가 없습니다.'}</Notice>}
  </Page>
}
