import { Text } from 'react-native'
import { Stack, Tabs, useLocalSearchParams } from 'expo-router'
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { ProgramReturnHeader, programReturnParams } from '../components/ProgramReturnHeader'
import { ProgramPreparationSection } from '../components/PreparationRows'

jest.mock('../components/usePreparationWorkspace', () => ({ usePreparationWorkspace: () => ({
  preparations: [], reviews: [], loading: false, preparationError: null, reviewError: null, refresh: jest.fn(),
}) }))
const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'P/123' }
function Program() { return <><Text>출발한 공고 상세</Text><ProgramPreparationSection token="owned" identity={identity} /></> }
function Preparation() { const params = useLocalSearchParams(); return <><ProgramReturnHeader params={params} /><Text>준비 화면</Text></> }
const routes = {
  _layout: () => <Stack screenOptions={{ animation: 'none' }}><Stack.Screen name="(tabs)" options={{ headerShown: false }} /></Stack>,
  '(tabs)/_layout': () => <Tabs screenOptions={{ headerShown: false }} />,
  '(tabs)/index': () => <Text>검색 화면</Text>,
  '(tabs)/all/_layout': { default: () => <Stack screenOptions={{ animation: 'none' }} />, unstable_settings: { anchor: 'index' } },
  '(tabs)/all/index': () => <Text>전체 메뉴</Text>,
  '(tabs)/all/preparation/new': Preparation, '(tabs)/all/reviews/new': Preparation,
  program: Program,
}
test.each(['+ 새 문서', '중복 검토 요청'])('%s carries the producer identity and its header returns directly to the originating program', async label => {
  const view = renderRouter(routes, { initialUrl: '/program?sourceCode=BIZINFO&sourceProgramId=P%2F123' })
  fireEvent.press(await screen.findByLabelText(label))
  await screen.findByText('준비 화면')
  expect(view.getSearchParams()).toMatchObject({ ...identity, from: 'program' })
  fireEvent.press(screen.getByLabelText('공고 상세로 돌아가기'))
  await waitFor(() => expect(view.getPathname()).toBe('/program'))
  expect(view.getSearchParams()).toMatchObject(identity)
  expect(screen.getByText('출발한 공고 상세')).toBeTruthy()
})
test('unknown source identities and arbitrary destinations never become a program header target', () => {
  expect(programReturnParams({ from: 'https://outside.test', ...identity })).toEqual({})
  expect(programReturnParams({ from: 'program', sourceCode: 'UNKNOWN', sourceProgramId: '123' })).toEqual({})
  expect(programReturnParams({ from: 'program', sourceCode: 'BIZINFO', sourceProgramId: ['123'] })).toEqual({})
})


test.each(['', 'x'.repeat(501), 'P\u0000bad', 'P\u200bbad'])('invalid program identifiers never create a return header target: %j', sourceProgramId => {
  expect(programReturnParams({ from: 'program', sourceCode: 'BIZINFO', sourceProgramId })).toEqual({})
})
