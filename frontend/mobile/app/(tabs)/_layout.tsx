import { Tabs } from 'expo-router'
import { Text } from 'react-native'
import { colors } from '../../src/ui'

export default function TabLayout() {
  return <Tabs screenOptions={{ headerTitle: 'GovBiz', headerTintColor: colors.text, headerStyle: { backgroundColor: colors.surface },
    tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, tabBarStyle: { borderTopColor: colors.border } }}>
    <Tabs.Screen name="index" options={{ title: '공고 찾기', tabBarIcon: ({ color }) => <Text style={{ fontSize: 25, color }}>⌕</Text> }} />
    <Tabs.Screen name="chat" options={{ title: 'AI 대화', tabBarIcon: ({ color }) => <Text style={{ fontSize: 22, color }}>✦</Text> }} />
    <Tabs.Screen name="saved" options={{ title: '관심 공고', tabBarIcon: ({ color }) => <Text style={{ fontSize: 25, color }}>♡</Text> }} />
    <Tabs.Screen name="account" options={{ title: '내 정보', tabBarIcon: ({ color }) => <Text style={{ fontSize: 25, color }}>○</Text> }} />
  </Tabs>
}
