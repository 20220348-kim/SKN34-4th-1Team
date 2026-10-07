import { Text } from 'react-native'
import { Stack } from 'expo-router'
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library'
import TabLayout from '../../app/(tabs)/_layout'
import ReportRoute from '../../app/(tabs)/report'
import SettingsRoute from '../../app/(tabs)/all/settings'
import * as AllLayout from '../../app/(tabs)/all/_layout'
import { useAuth } from '../auth/session'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => jest.fn() }))
// Settings contents are exercised separately; these tests mount the actual app routes and native headers.
jest.mock('./DailyReportScreen', () => {
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native')
  return { DailyReportScreen: ({ settingsOnly, reportId, onSettings }: {
    settingsOnly?: boolean; reportId?: string; onSettings?(): void
  }) => <View><Text>{settingsOnly ? '알림 설정 화면' : '리포트 화면'}</Text>
    {!settingsOnly && <Text>{`현재 리포트 ${reportId ?? 'latest'}`}</Text>}
    {onSettings && <Pressable accessibilityRole="button" accessibilityLabel="알림 설정 열기" onPress={onSettings}><Text>알림 설정 열기</Text></Pressable>}
  </View> }
})

const Placeholder = () => <Text>다른 화면</Text>
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>,
  '(tabs)/_layout': TabLayout,
  '(tabs)/index': Placeholder, '(tabs)/saved': Placeholder, '(tabs)/collab': Placeholder,
  '(tabs)/account': Placeholder, '(tabs)/chat': Placeholder,
  '(tabs)/report': ReportRoute,
  '(tabs)/all/_layout': AllLayout,
  '(tabs)/all/index': () => <Text>전체 메뉴</Text>,
  '(tabs)/all/account': Placeholder, '(tabs)/all/company': Placeholder,
  '(tabs)/all/settings': SettingsRoute,
  '(tabs)/all/preparation': Placeholder, '(tabs)/all/preparation/new': Placeholder,
  '(tabs)/all/preparation/[id]': Placeholder, '(tabs)/all/preparation/[id]/review': Placeholder,
  '(tabs)/all/preparation/[id]/documents': Placeholder, '(tabs)/all/preparation/[id]/online': Placeholder,
  '(tabs)/all/reviews/index': Placeholder, '(tabs)/all/reviews/new': Placeholder,
  '(tabs)/all/reviews/[id]': Placeholder, '(tabs)/all/collab': Placeholder,
}

beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner' } } as unknown as ReturnType<typeof useAuth>)
})

// The first native navigator mount includes initialization on Windows.
test.each([undefined, '7'])('report %s opens notification settings and returns through its header to the same report', async reportId => {
  const view = renderRouter(routes, { initialUrl: reportId ? `/report?reportId=${reportId}` : '/report' })
  await screen.findByText('리포트 화면', {}, { timeout: 5000 })
  fireEvent.press(screen.getByLabelText('알림 설정 열기'))
  await screen.findByText('알림 설정 화면', {}, { timeout: 5000 })
  expect(view.getPathname()).toBe('/all/settings')
  expect(screen.getByLabelText('전체').props.accessibilityState.selected).toBe(true)
  fireEvent.press(await screen.findByLabelText('리포트로 돌아가기'))
  await screen.findByText('리포트 화면')
  expect(view.getPathname()).toBe('/report')
  expect(screen.getByText(`현재 리포트 ${reportId ?? 'latest'}`)).toBeTruthy()
  expect(screen.getByLabelText('리포트').props.accessibilityState.selected).toBe(true)
}, 15000)

test('a direct report settings link returns to its selected report without an earlier report route', async () => {
  const view = renderRouter(routes, { initialUrl: '/all/settings?from=report&reportId=7' })
  fireEvent.press(await screen.findByLabelText('리포트로 돌아가기'))
  await screen.findByText('리포트 화면')
  expect(view.getPathname()).toBe('/report')
  expect(screen.getByText('현재 리포트 7')).toBeTruthy()
})

test('settings opened from All retains the native All return instead of a report return header', async () => {
  renderRouter(routes, { initialUrl: '/all/settings' })
  await screen.findByText('알림 설정 화면')
  expect(screen.queryByLabelText('리포트로 돌아가기')).toBeNull()
})
