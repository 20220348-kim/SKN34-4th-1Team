import { act, fireEvent, waitFor } from '@testing-library/react-native'
import { Alert, Text } from 'react-native'
import { Stack, router } from 'expo-router'
import { renderRouter, screen } from 'expo-router/testing-library'
import RecruitmentRoute from '../../app/partner/[id]'
import RecruitmentEditRoute from '../../app/partner/edit'
import { useAuth } from '../auth/session'
import { LoginFlowProvider } from '../auth/loginFlow'
import { getRecruitment, updateRecruitment } from '../api/partners'
import { programClient } from '../api/client'
import { ownedRecruitment } from '../test/recruitmentFixtures'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), getRecruitment: jest.fn(), updateRecruitment: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
const routes = {
  _layout: () => <LoginFlowProvider><Stack screenOptions={{ animation: 'none' }} /></LoginFlowProvider>,
  index: () => <Text>검색 화면</Text>,
  'partner/[id]': RecruitmentRoute,
  'partner/edit': RecruitmentEditRoute,
}
beforeEach(() => {
  jest.mocked(useAuth).mockReturnValue({ status: 'signedIn', session: { accessToken: 'owner', account: {
    email: 'owner@test.com', company: { companyName: '등록 기업', businessStatusCode: '01' } } }, invalidateSession: jest.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof useAuth>)
  jest.mocked(getRecruitment).mockReset().mockResolvedValue(ownedRecruitment)
  jest.mocked(updateRecruitment).mockReset()
  jest.mocked(programClient).mockReturnValue({ getDetail: jest.fn().mockResolvedValue({ status: 'OPEN' }) } as unknown as ReturnType<typeof programClient>)
  delete process.env.EXPO_PUBLIC_WEB_BASE_URL
})
afterEach(() => jest.restoreAllMocks())

test('the actual detail edit action loads native inputs and save returns to the refreshed detail without a web session', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  jest.mocked(updateRecruitment).mockImplementation(async (_id, content) => {
    const edited = { ...ownedRecruitment, ...content }
    jest.mocked(getRecruitment).mockResolvedValue(edited)
    return { outcome: 'updated', recruitment: edited }
  })
  const view = renderRouter(routes, { initialUrl: '/partner/19' })
  fireEvent.press(await screen.findByLabelText('수정'))
  await screen.findByDisplayValue(ownedRecruitment.title)
  expect(view.getPathname()).toBe('/partner/edit')
  expect(view.getSearchParams()).toMatchObject({ id: '19' })
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '앱에서 수정한 모집글')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await waitFor(() => expect(view.getPathname()).toBe('/partner/19'))
  await screen.findByText('앱에서 수정한 모집글')
  expect(getRecruitment).toHaveBeenCalledWith(19, 'owner', expect.any(AbortSignal))
  expect(alert).not.toHaveBeenCalled()
  expect(screen.queryByDisplayValue('앱에서 수정한 모집글')).toBeNull()
})

test('native back navigation protects edited content and confirmation returns to the original detail', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const view = renderRouter(routes, { initialUrl: '/partner/19' })
  fireEvent.press(await screen.findByLabelText('수정'))
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('협업 소개 *'), '저장하지 않은 수정 소개')
  await act(async () => router.back())
  await waitFor(() => expect(alert).toHaveBeenCalledWith('수정 중인 모집글을 나갈까요?', expect.any(String), expect.any(Array)))
  expect(view.getPathname()).toBe('/partner/edit')
  expect(screen.getByDisplayValue('저장하지 않은 수정 소개')).toBeTruthy()
  await act(async () => alert.mock.calls[0][2]?.find(button => button.text === '나가기')?.onPress?.())
  await waitFor(() => expect(view.getPathname()).toBe('/partner/19'))
  expect(updateRecruitment).not.toHaveBeenCalled()
})

test('a deep-linked unchanged edit cancels to its detail without discarding other data', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  const view = renderRouter(routes, { initialUrl: '/partner/edit?id=19' })
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.press(screen.getByLabelText('취소'))
  await waitFor(() => expect(view.getPathname()).toBe('/partner/19'))
  expect(alert).not.toHaveBeenCalled()
  expect(updateRecruitment).not.toHaveBeenCalled()
})

test.each(['', '0', '-1', 'abc', '1.5', '9007199254740992'])('an invalid edit id %s cannot read or write a recruitment', async (id) => {
  renderRouter(routes, { initialUrl: `/partner/edit?id=${id}` })
  await screen.findByText('모집글 수정 링크가 올바르지 않습니다.')
  expect(getRecruitment).not.toHaveBeenCalled()
  expect(updateRecruitment).not.toHaveBeenCalled()
})

test('back during saving remains blocked until the acknowledged save returns to the detail', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  let finish!: (value: Awaited<ReturnType<typeof updateRecruitment>>) => void
  jest.mocked(updateRecruitment).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = renderRouter(routes, { initialUrl: '/partner/19' })
  fireEvent.press(await screen.findByLabelText('수정'))
  await screen.findByDisplayValue(ownedRecruitment.title)
  fireEvent.changeText(screen.getByLabelText('모집글 제목 *'), '저장 중인 제목')
  fireEvent.press(screen.getByLabelText('수정 내용 저장'))
  await act(async () => router.back())
  expect(view.getPathname()).toBe('/partner/edit')
  expect(alert).toHaveBeenCalledWith('모집글 저장을 확인 중이에요', expect.any(String))
  const edited = { ...ownedRecruitment, title: '저장 중인 제목' }
  jest.mocked(getRecruitment).mockResolvedValue(edited)
  alert.mockClear()
  await act(async () => finish({ outcome: 'updated', recruitment: edited }))
  await waitFor(() => expect(view.getPathname()).toBe('/partner/19'))
  await screen.findByText('저장 중인 제목')
  expect(alert).not.toHaveBeenCalled()
})
