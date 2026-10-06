import { useEffect } from 'react'
import { Tabs, usePathname, useRouter } from 'expo-router'
import { StackActions, type NavigationState } from 'expo-router/react-navigation'
import { AppIcon } from '../../src/components/AppIcon'
import { ReportHeaderAction } from './report'
import { colors } from '../../src/ui'
import { useAuth } from '../../src/auth/session'

export default function TabLayout() {
  const { status, session } = useAuth()
  const signedIn = status === 'signedIn' && session !== null
  const pathname = usePathname()
  const router = useRouter()
  useEffect(() => {
    if (status === 'signedOut' && (pathname === '/saved' || pathname === '/report')) router.replace('/(tabs)')
  }, [status, pathname, router])
  return <Tabs initialRouteName="index" screenOptions={{ headerTintColor: colors.text, headerTitleAlign: 'left',
    headerTitleStyle: { fontSize: 18, fontWeight: '700' }, headerShadowVisible: false, headerStyle: { backgroundColor: colors.surface },
    tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, tabBarHideOnKeyboard: true,
    tabBarLabelStyle: { fontSize: 11, fontWeight: '500' }, tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, elevation: 0 } }}>
    <Tabs.Screen name="index" options={{ title: '검색', tabBarAccessibilityLabel: '검색', headerTitle: '지원사업 검색', tabBarIcon: ({ color, focused }) => <AppIcon name="search" color={color} selected={focused} /> }} />
    <Tabs.Screen name="collab" options={{ href: signedIn ? null : undefined, title: '협업', tabBarAccessibilityLabel: '협업', headerTitle: '협업 모집글',
      tabBarIcon: ({ color, focused }) => <AppIcon name="collaboration" color={color} selected={focused} /> }} />
    <Tabs.Screen name="saved" options={{ href: signedIn ? undefined : null, title: '관심함', tabBarAccessibilityLabel: '관심함', headerTitle: '관심 공고함', tabBarIcon: ({ color, focused }) => <AppIcon name="bookmark" color={color} selected={focused} /> }} />
    <Tabs.Screen name="report" options={{ href: signedIn ? undefined : null, title: '리포트', tabBarAccessibilityLabel: '리포트', headerTitle: '맞춤 리포트',
      headerRight: () => <ReportHeaderAction />, tabBarIcon: ({ color, focused }) => <AppIcon name="report" color={color} selected={focused} /> }} />
    <Tabs.Screen name="all" listeners={({ navigation, route }) => ({ tabPress: (event) => {
      const stack = (navigation.getState() as NavigationState).routes.find(item => item.key === route.key)?.state
      if (stack?.type !== 'stack' || !stack.key) {
        // 직접 진입한 화면은 탭 상태에 Stack 키가 아직 반영되지 않을 수 있다.
        if (navigation.isFocused()) { event.preventDefault(); router.dismissTo('/(tabs)/all') }
        return
      }
      const source = stack.routes[stack.index ?? stack.routes.length - 1]?.key
      if (!source) return
      // 항상 메뉴로 돌아가되, 하위 화면의 미저장 입력 이탈 방지는 그대로 거친다.
      event.preventDefault()
      navigation.dispatch({ ...StackActions.popTo('index'), source, target: stack.key })
      if (!navigation.isFocused()) navigation.navigate(route.name)
    } })} options={{ title: '전체', tabBarAccessibilityLabel: '전체', headerShown: false,
      tabBarIcon: ({ color }) => <AppIcon name="menu" color={color} /> }} />
    <Tabs.Screen name="account" options={{ href: null }} />
    <Tabs.Screen name="chat" options={{ href: null }} />
  </Tabs>
}
