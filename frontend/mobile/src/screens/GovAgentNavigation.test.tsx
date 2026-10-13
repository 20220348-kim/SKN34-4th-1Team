import { Text } from 'react-native'
import { Stack, Tabs, useLocalSearchParams } from 'expo-router'
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import SearchRoute from '../../app/(tabs)/index'

jest.mock('../auth/session', () => ({ useAuth: () => ({ status: 'signedIn' }) }))
jest.mock('../auth/loginFlow', () => ({ useLoginFlow: () => jest.fn() }))
jest.mock('../assistant/context', () => ({ useAssistant: () => ({ searchDraft: null, consumeSearchDraft: jest.fn() }) }))
jest.mock('./SearchScreen', () => ({ SearchScreen: (props: Parameters<typeof import('./SearchScreen').SearchScreen>[0]) => {
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native')
  const program = { sourceCode: 'BIZINFO', sourceProgramId: 'P/123', title: '연결할 공고' }
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel="새 신청" onPress={() => props.onOpenApplication!({ program, message: '신청' })}><Text>새 신청</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="저장한 신청" onPress={() => props.onOpenApplication!({ program, message: '신청', preparationId: 9 })}><Text>저장한 신청</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="새 검토" onPress={() => props.onOpenReview!({ program, message: '검토' })}><Text>새 검토</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="선택 없는 검토" onPress={() => props.onOpenReview!({ program: null, message: '검토' })}><Text>선택 없는 검토</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="저장한 검토" onPress={() => props.onOpenReview!({ program, message: '검토', reviewId: 5 })}><Text>저장한 검토</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="파트너 조회" onPress={() => props.onOpenPartners!()}><Text>파트너 조회</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="모집글 상세" onPress={() => props.onOpenRecruitment!(14)}><Text>모집글 상세</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="공고 질문 이동" onPress={() => props.onOpenProgram(program, { ask: true })}><Text>공고 질문 이동</Text></Pressable>
  </View>
} }))
function Destination() { return <Text testID="gov-destination">{JSON.stringify(useLocalSearchParams())}</Text> }
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }} />,
  '(tabs)/_layout': () => <Tabs screenOptions={{ animation: 'none' }} />,
  '(tabs)/index': SearchRoute,
  '(tabs)/all/_layout': () => <Stack screenOptions={{ animation: 'none' }} />,
  '(tabs)/all/preparation/new': Destination,
  '(tabs)/all/preparation/[id]': Destination,
  '(tabs)/all/reviews/new': Destination,
  '(tabs)/all/reviews/[id]': Destination,
  '(tabs)/all/collab': Destination,
  'partner/[id]': Destination,
  program: Destination,
}
test.each([
  ['새 신청', '/all/preparation/new', { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }],
  ['저장한 신청', '/all/preparation/9', { id: '9' }],
  ['새 검토', '/all/reviews/new', { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }],
  ['선택 없는 검토', '/all/reviews/new', {}],
  ['저장한 검토', '/all/reviews/5', { id: '5', step: 'analysis' }],
  ['파트너 조회', '/all/collab', { view: 'recruitments', mine: '0' }],
  ['모집글 상세', '/partner/14', { id: '14' }],
  ['공고 질문 이동', '/program', { sourceCode: 'BIZINFO', sourceProgramId: 'P/123', ask: '1' }],
] as const)('%s connects to %s with native parameters', async (label, path, params) => {
  const view = renderRouter(routes, { initialUrl: '/' })
  fireEvent.press(screen.getByLabelText(label))
  await waitFor(() => expect(view.getPathname()).toBe(path))
  expect(JSON.parse(screen.getByTestId('gov-destination').props.children)).toMatchObject(params)
})
