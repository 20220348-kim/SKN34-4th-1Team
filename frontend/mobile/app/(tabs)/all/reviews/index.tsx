import { Pressable } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { AppIcon } from '../../../../src/components/AppIcon'
import { CombinationReviewListScreen } from '../../../../src/screens/CombinationReviewScreens'
import { Button, colors } from '../../../../src/ui'
export default function ReviewListRoute() {
  const router = useRouter()
  return <><Stack.Screen options={{ headerLeft: () => <Pressable accessibilityRole="button" accessibilityLabel="전체로 돌아가기" onPress={() => router.navigate('/all')}
    style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}><AppIcon name="back" color={colors.text} size={20} /></Pressable>,
    headerRight: () => <Button label="새 검토 ＋" variant="ghost" onPress={() => router.push('/all/reviews/new')} /> }} />
    <CombinationReviewListScreen onNew={() => router.push('/all/reviews/new')} onLogin={() => router.push('/all/account')} /></>
}
