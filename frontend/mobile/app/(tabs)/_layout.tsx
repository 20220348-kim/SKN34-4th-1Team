import { Tabs } from 'expo-router'
import { AppIcon } from '../../src/components/AppIcon'
import { ReportHeaderAction } from './report'
import { colors } from '../../src/ui'

export default function TabLayout() {
  return <Tabs initialRouteName="index" screenOptions={{ headerTintColor: colors.text, headerTitleAlign: 'left',
    headerTitleStyle: { fontSize: 18, fontWeight: '700' }, headerShadowVisible: false, headerStyle: { backgroundColor: colors.surface },
    tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, tabBarHideOnKeyboard: true,
    tabBarLabelStyle: { fontSize: 11, fontWeight: '500' }, tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, elevation: 0 } }}>
    <Tabs.Screen name="index" options={{ title: '검색', tabBarAccessibilityLabel: '검색', headerTitle: '지원사업 검색', tabBarIcon: ({ color, focused }) => <AppIcon name="search" color={color} selected={focused} /> }} />
    <Tabs.Screen name="saved" options={{ title: '관심함', tabBarAccessibilityLabel: '관심함', headerTitle: '관심 공고함', tabBarIcon: ({ color, focused }) => <AppIcon name="bookmark" color={color} selected={focused} /> }} />
    <Tabs.Screen name="report" options={{ title: '리포트', tabBarAccessibilityLabel: '리포트', headerTitle: '맞춤 리포트',
      headerRight: () => <ReportHeaderAction />, tabBarIcon: ({ color, focused }) => <AppIcon name="report" color={color} selected={focused} /> }} />
    <Tabs.Screen name="all" options={{ title: '전체', tabBarAccessibilityLabel: '전체', headerShown: false,
      tabBarIcon: ({ color }) => <AppIcon name="menu" color={color} /> }} />
    <Tabs.Screen name="collab" options={{ href: null }} />
    <Tabs.Screen name="account" options={{ href: null }} />
    <Tabs.Screen name="chat" options={{ href: null }} />
  </Tabs>
}
