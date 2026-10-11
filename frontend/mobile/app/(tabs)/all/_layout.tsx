import { Stack } from 'expo-router'
import { screenTitles } from '@govbiz/shared/design/screenTitles'
import { CollaborationHeaderAction } from './collab'
import { colors } from '../../../src/ui'

export const unstable_settings = { anchor: 'index' }

export default function AllLayout() {
  return <Stack screenOptions={{ headerTintColor: colors.text, headerTitleAlign: 'left', headerBackTitle: screenTitles.menu,
    headerTitleStyle: { fontSize: 18, fontWeight: '700' }, headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.surface }, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="account" options={{ title: screenTitles.profile }} />
    <Stack.Screen name="company" options={{ title: screenTitles.companyProfile }} />
    <Stack.Screen name="settings" options={{ title: screenTitles.notificationSettings }} />
    <Stack.Screen name="pricing" options={{ title: screenTitles.pricing }} />
    <Stack.Screen name="preparation" options={{ title: screenTitles.applicationPreparations }} />
    <Stack.Screen name="preparation/new" options={{ title: screenTitles.applicationPreparationNew }} />
    <Stack.Screen name="preparation/[id]" options={{ title: screenTitles.applicationPreparationEditor }} />
    <Stack.Screen name="preparation/[id]/review" options={{ title: screenTitles.applicationPreparationReview }} />
    <Stack.Screen name="preparation/[id]/documents" options={{ title: screenTitles.applicationPreparationDocuments }} />
    <Stack.Screen name="preparation/[id]/online" options={{ title: screenTitles.onlineInputGuide }} />
    <Stack.Screen name="reviews/index" options={{ title: screenTitles.combinationReviews }} />
    <Stack.Screen name="reviews/new" options={{ title: screenTitles.combinationReviewNew }} />
    <Stack.Screen name="reviews/[id]" options={{ title: screenTitles.combinationReviewDetail }} />
    <Stack.Screen name="collab" options={{ title: screenTitles.partnerManagement, headerRight: () => <CollaborationHeaderAction /> }} />
  </Stack>
}
