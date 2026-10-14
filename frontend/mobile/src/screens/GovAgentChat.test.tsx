import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native'
import { Alert, Linking, ScrollView } from 'react-native'
import type { GovAgentResult } from '@govbiz/shared/domain/entities/GovAgent'
import { GovAgentApiError } from '@govbiz/shared/data/api/govAgentApi'
import { chatConversationSnapshotSchema } from '@govbiz/shared/data/models/ChatConversationDto'
import { ChatScreen } from './ChatScreen'
import { SearchScreen } from './SearchScreen'
import { chatSnapshot, emptyChatContext } from './chatConversationState'
import { ApiError, programClient } from '../api/client'
import { getChatConversation, listChatConversations, saveChatConversation } from '../api/chatConversations'
import { planUsageUseCase } from '../api/planUsage'
import { useAuth } from '../auth/session'
import { programDetail } from '../test/preparationFixtures'
import { emptyPartnerRecruitmentConditions } from '@govbiz/shared/domain/entities/PartnerRecruitmentRecommendation'
import { recommendRecruitments } from '../api/partners'

jest.mock('../auth/session', () => ({ useAuth: jest.fn() }))
jest.mock('../api/client', () => ({ ...jest.requireActual('../api/client'), programClient: jest.fn() }))
jest.mock('../api/planUsage', () => ({ planUsageUseCase: jest.fn() }))
jest.mock('../api/savedPrograms', () => ({ ...jest.requireActual('../api/savedPrograms'), listSavedPrograms: jest.fn().mockResolvedValue([]) }))
jest.mock('../api/partners', () => ({ ...jest.requireActual('../api/partners'), recommendRecruitments: jest.fn().mockResolvedValue({
  items: [], total: 0, basis: { hasCompany: false, profileSet: false, roles: [], capabilityCount: 0, myProgramCount: 0, region: null }, relax: [], suggestedProgram: null,
}) }))
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), useFocusEffect: (callback: () => void) => {
  const React = jest.requireActual<typeof import('react')>('react'); React.useEffect(callback, [callback])
} }))
jest.mock('../api/chatConversations', () => ({ getChatConversation: jest.fn(), listChatConversations: jest.fn(), saveChatConversation: jest.fn(), deleteChatConversation: jest.fn() }))
let mockMessageNumber = 0, mockReviewMounts = 0
jest.mock('expo-crypto', () => ({ randomUUID: () => `gov-message-${++mockMessageNumber}` }))
jest.mock('./ApplicationPreparationNewScreen', () => ({ ApplicationPreparationNewScreen: (props: Parameters<typeof import('./ApplicationPreparationNewScreen').ApplicationPreparationNewScreen>[0]) => {
  const { Text, Pressable } = jest.requireActual<typeof import('react-native')>('react-native')
  return <><Text>신청 분석 패널</Text><Pressable accessibilityRole="button" accessibilityLabel="양식 선택하고 쓰기" onPress={props.onOpenForms}><Text>양식 선택하고 쓰기</Text></Pressable></>
} }))
jest.mock('./CombinationReviewScreens', () => ({ CombinationReviewEditorScreen: (props: Parameters<typeof import('./CombinationReviewScreens').CombinationReviewEditorScreen>[0]) => {
  const React = jest.requireActual<typeof import('react')>('react')
  const { TextInput, Text, Pressable } = jest.requireActual<typeof import('react-native')>('react-native')
  const [title, setTitle] = React.useState('')
  React.useEffect(() => { mockReviewMounts += 1 }, [])
  return <><TextInput accessibilityLabel="대화 검토 제목" value={title} onChangeText={setTitle} />
    <Pressable accessibilityRole="button" accessibilityLabel="검토 입력 저장" onPress={() => props.onStepChange?.(5, 'confirm')}><Text>검토 입력 저장</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="검토 실행" onPress={() => props.onStepChange?.(5, 'analysis')}><Text>검토 실행</Text></Pressable></>
} }))

const program = { ...programDetail, title: '관리자 추천 공고', matchedReasons: [], recommendationScore: null, eligibilityReview: null, evidenceQuestionSupported: true }
const identity = { sourceCode: program.sourceCode, sourceProgramId: program.id }
const selection = { ...identity, title: program.title }
const proposal = { status: 'READY' as const, proposedContext: { ...emptyChatContext, query: '서울 사업화' }, clarificationQuestion: null, changedFields: [] }
const evidence: GovAgentResult = { outcome: 'EVIDENCE', program: identity, evidence: { answer: '누리집에서 신청하세요.', answerStatus: 'ANSWERED',
  citations: [{ excerpt: '온라인 신청', sourceUrl: program.sourceUrl, sourceLabel: '기업마당 상세 본문', chunkOrder: 0 }] } }
const client = { sendGovAgentMessage: jest.fn(), interpretConversation: jest.fn(), getSearchReadiness: jest.fn(), search: jest.fn() }
const props = { onOpenProgram: jest.fn(), onLogin: jest.fn(), onOpenApplication: jest.fn(), onOpenReview: jest.fn(), onOpenPartners: jest.fn() }
function auth(role: 'ADMIN' | 'USER' = 'ADMIN', accessToken = 'admin-session') {
  const value = { status: 'signedIn', session: { accessToken, account: { role, email: 'owner@example.com' } }, invalidateSession: jest.fn().mockResolvedValue(undefined) }
  jest.mocked(useAuth).mockReturnValue(value as unknown as ReturnType<typeof useAuth>)
  return value
}
beforeEach(() => {
  mockMessageNumber = 0; mockReviewMounts = 0; auth()
  Object.values(props).forEach(mock => mock.mockReset())
  client.sendGovAgentMessage.mockReset().mockResolvedValue({ outcome: 'SEARCH', interpretation: proposal })
  client.interpretConversation.mockReset().mockResolvedValue(proposal)
  client.getSearchReadiness.mockReset().mockResolvedValue({ indexReady: true, searchState: 'SEARCHABLE' })
  client.search.mockReset().mockResolvedValue({ query: '서울 사업화', programs: [program], totalCount: 1, resultToken: null, expiresAt: null })
  jest.mocked(programClient).mockReturnValue(client as unknown as ReturnType<typeof programClient>)
  jest.mocked(planUsageUseCase).mockReturnValue({ usage: () => new Promise(() => undefined) } as ReturnType<typeof planUsageUseCase>)
  jest.mocked(saveChatConversation).mockReset().mockImplementation(async (_token, _email, id, version) => ({ id, title: 'Gov 대화', version: version + 1, updatedAt: '2026-10-13T09:00:00' }))
  jest.mocked(listChatConversations).mockReset().mockResolvedValue({ items: [{ id: 'record', title: 'Gov 기록', version: 1, updatedAt: '2026-10-13T09:00:00' }], nextCursor: null })
  jest.mocked(getChatConversation).mockReset()
})
afterEach(() => jest.restoreAllMocks())
async function send(text: string) {
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), text)
  await act(async () => fireEvent.press(screen.getByLabelText('AI에게 보내기')))
}
async function select() {
  await send('서울 사업화 지원 찾아줘')
  expect(client.search).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByLabelText('이 조건으로 검색')))
  await act(async () => fireEvent.press(screen.getByLabelText(`${program.title}, 이 공고 선택`)))
}

test('ADMIN switches the tab and API; USER and guests retain their existing interpretation', async () => {
  const view = render(<SearchScreen mode="ai" onModeChange={jest.fn()} {...props} />)
  expect(screen.getByRole('tab', { name: 'Gov 에이전트' })).toBeTruthy()
  await select()
  expect(programClient).toHaveBeenCalledWith('admin-session')
  expect(client.sendGovAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ selectedProgram: null }), expect.any(AbortSignal))
  expect(client.interpretConversation).not.toHaveBeenCalled()
  expect(within(screen.getByLabelText('선택 공고의 세 가지 기능')).getAllByRole('button').map(button => button.props.accessibilityLabel))
    .toEqual(['신청 문서 쓰기', '중복 검토', '파트너 찾기'])
  expect(screen.queryByLabelText('원문 질문')).toBeNull()
  auth('USER'); view.rerender(<SearchScreen mode="ai" onModeChange={jest.fn()} {...props} />)
  expect(screen.queryByRole('tab', { name: 'Gov 에이전트' })).toBeNull()
  expect(screen.getByRole('tab', { name: 'AI 대화 검색' })).toBeTruthy()
  expect(screen.queryByTestId('gov-agent-selected-program')).toBeNull()
  await send('회원 검색')
  jest.mocked(useAuth).mockReturnValue({ status: 'signedOut', session: null } as ReturnType<typeof useAuth>)
  view.rerender(<SearchScreen mode="ai" onModeChange={jest.fn()} {...props} />)
  await send('비로그인 검색')
  expect(client.interpretConversation).toHaveBeenCalledTimes(2)
  expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(1)
})

test.each(['ADMIN', 'USER'] as const)('the result-card question button keeps the current %s question flow after main synchronization', async role => {
  auth(role)
  render(<ChatScreen {...props} />)
  await send('사업화 지원 찾아줘')
  await act(async () => fireEvent.press(screen.getByLabelText('이 조건으로 검색')))
  await act(async () => fireEvent.press(screen.getByLabelText(/관리자 추천 공고, .*질문/)))
  if (role === 'ADMIN') {
    expect(screen.getByTestId('gov-agent-selected-program')).toBeTruthy()
    expect(props.onOpenProgram).not.toHaveBeenCalled()
  } else expect(props.onOpenProgram).toHaveBeenCalledWith(identity, { ask: true })
})

test('the first question click places the selected program and four questions after all five cards and scrolls there', async () => {
  const programs = Array.from({ length: 5 }, (_, index) => ({ ...program, id: `result-${index}`, title: `추천 공고 ${index + 1}` }))
  client.search.mockResolvedValue({ query: '서울 사업화', programs, totalCount: 5, resultToken: null, expiresAt: null })
  const scroll = jest.spyOn(ScrollView.prototype, 'scrollTo')
  const frames: FrameRequestCallback[] = []
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  render(<ChatScreen {...props} />)
  await send('사업화 지원 찾아줘')
  await act(async () => fireEvent.press(screen.getByLabelText('이 조건으로 검색')))
  const calls = client.sendGovAgentMessage.mock.calls.length
  await act(async () => fireEvent.press(screen.getByLabelText('추천 공고 1, 이 공고에 질문하기')))
  const selected = screen.getByTestId('gov-agent-selected-program')
  expect(within(selected).getByText('선택한 공고: 추천 공고 1')).toBeTruthy()
  expect(within(selected).getAllByRole('button').map(button => button.props.accessibilityLabel))
    .toEqual(['공고 선택 해제', '지원 대상', '신청 방법', '신청 기간', '문의처', '신청 문서 쓰기', '중복 검토', '파트너 찾기'])
  expect(screen.getAllByLabelText('신청 방법')).toHaveLength(1)
  const timeline = screen.getByTestId('ai-search-timeline')
  expect(within(timeline).getByTestId('gov-agent-selected-program')).toBeTruthy()
  expect(within(screen.getByTestId('ai-search-results')).queryByLabelText('신청 방법')).toBeNull()
  expect(within(screen.getByTestId('ai-search-composer')).queryByTestId('gov-agent-selected-program')).toBeNull()
  fireEvent(timeline, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 600 } } })
  fireEvent(selected, 'layout', { nativeEvent: { layout: { x: 0, y: 3000, width: 360, height: 300 } } })
  fireEvent(timeline, 'contentSizeChange', 360, 3300)
  act(() => { frames.splice(0).forEach(callback => callback(0)) })
  expect(scroll).toHaveBeenLastCalledWith({ y: 2700, animated: true })
  expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(calls)
  expect(client.search).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.press(screen.getByLabelText('추천 공고 5, 이 공고 선택')))
  expect(screen.getByText('선택한 공고: 추천 공고 5')).toBeTruthy()
  expect(screen.queryByText('선택한 공고: 추천 공고 1')).toBeNull()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '작성 중인 질문')
  expect(screen.getByLabelText('신청 방법')).toBeDisabled()
})

test('the selected composite identity is used for evidence and saved; answered quick questions do not repeat', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  render(<ChatScreen {...props} />); await select()
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![4].govProgram).toEqual(selection)
  const calls = client.sendGovAgentMessage.mock.calls.length
  await act(async () => fireEvent.press(screen.getByLabelText(`${program.title}, 이 공고에 질문하기`)))
  expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(calls)
  client.sendGovAgentMessage.mockResolvedValue(evidence)
  await act(async () => fireEvent.press(screen.getByLabelText('신청 방법')))
  expect(client.sendGovAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({ selectedProgram: identity,
    conversation: expect.objectContaining({ message: '이 공고는 어떻게 신청하나요?' }) }), expect.any(AbortSignal))
  expect(screen.getByText('누리집에서 신청하세요.')).toBeTruthy()
  expect(screen.queryByLabelText('신청 방법')).toBeNull()
  expect(screen.queryByText('온라인 신청')).toBeNull()
  fireEvent.press(screen.getByLabelText('근거 원문 1건 보기'))
  expect(screen.getByText('온라인 신청')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('근거 1 · 기업마당 상세 본문 ↗'))
  await waitFor(() => expect(open).toHaveBeenCalledWith(program.sourceUrl))
  const snapshot = jest.mocked(saveChatConversation).mock.calls.at(-1)![4]
  expect(chatConversationSnapshotSchema.parse(snapshot).messages.at(-1)!.govEvidence?.program).toEqual(selection)
  expect(client.search).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.press(screen.getByLabelText('공고 선택 해제')))
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![4].govProgram).toBeNull()
})

test('application opens inside the conversation without a route-selection AI call, then moves to forms', async () => {
  render(<ChatScreen {...props} />); await select()
  await act(async () => fireEvent.press(screen.getByLabelText('신청 문서 쓰기')))
  expect(screen.getByText('신청 분석 패널')).toBeTruthy()
  expect(screen.getByTestId('ai-search-composer')).toBeTruthy()
  expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByLabelText('접기'))
  expect(screen.queryByText('신청 분석 패널')).toBeNull()
  fireEvent.press(screen.getByLabelText('입력칸 분석 보기'))
  fireEvent.press(screen.getByLabelText('양식 선택하고 쓰기'))
  expect(props.onOpenApplication).toHaveBeenCalledWith(expect.objectContaining({ program: selection }))
})

test('the partner button preserves the selected composite identity without another AI call', async () => {
  render(<ChatScreen {...props} />); await select()
  const calls = client.sendGovAgentMessage.mock.calls.length
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '이어서 작성 중인 질문')
  expect(screen.getByLabelText('파트너 찾기')).toBeDisabled()
  fireEvent.press(screen.getByLabelText('파트너 찾기'))
  expect(recommendRecruitments).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '')
  await act(async () => fireEvent.press(screen.getByLabelText('파트너 찾기')))
  const conditions = { ...emptyPartnerRecruitmentConditions, program: identity }
  expect(recommendRecruitments).toHaveBeenLastCalledWith(conditions, 'admin-session', expect.any(AbortSignal))
  expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(calls)
  expect(client.interpretConversation).not.toHaveBeenCalled()
  const snapshot = jest.mocked(saveChatConversation).mock.calls.at(-1)![4]
  expect(chatConversationSnapshotSchema.parse(snapshot).messages.at(-1)!.govPartners?.conditions).toEqual(conditions)
  fireEvent.press(screen.getByLabelText('같은 조건으로 파트너 관리에서 보기'))
  expect(props.onOpenPartners).toHaveBeenCalledWith(conditions)
})

test('selecting a program does not repeat evidence usage beside the three actions', async () => {
  jest.mocked(planUsageUseCase).mockReturnValue({ usage: jest.fn().mockResolvedValue({ plan: 'PLUS', items: [
    { feature: 'AI_SEARCH', period: 'PLAN', limit: 100, used: 1, resetsAt: '2099-01-01T00:00:00+09:00' },
    { feature: 'EVIDENCE_QUESTION', period: 'PLAN', limit: 100, used: 1, resetsAt: '2099-01-01T00:00:00+09:00' },
  ] }) } as unknown as ReturnType<typeof planUsageUseCase>)
  render(<ChatScreen {...props} />); await select()
  expect(screen.getByText('AI 대화 검색 이번 기간 99회 남음')).toBeTruthy()
  expect(within(screen.getByTestId('gov-agent-selected-program')).queryByText(/공고 원문 질문/)).toBeNull()
  expect(screen.getByLabelText(`${program.title}, 이 공고에 질문하기`)).toBeEnabled()
})

test('review drafts survive collapse, saving the ID and another answer; execution opens the native result', async () => {
  render(<ChatScreen {...props} />); await select()
  await act(async () => fireEvent.press(screen.getByLabelText('중복 검토')))
  fireEvent.changeText(screen.getByLabelText('대화 검토 제목'), '유지할 제목')
  await act(async () => fireEvent.press(screen.getByLabelText('검토 입력 저장')))
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![4].messages.at(-1)!.govReview?.reviewId).toBe(5)
  expect(mockReviewMounts).toBe(1)
  fireEvent.press(screen.getByLabelText('접기'))
  expect(screen.queryByLabelText('대화 검토 제목')).toBeNull()
  fireEvent.press(screen.getByLabelText('검토 입력 이어서 보기'))
  expect(screen.getByDisplayValue('유지할 제목')).toBeTruthy()
  client.sendGovAgentMessage.mockResolvedValue(evidence)
  await send('지원 대상은?')
  expect(screen.getByDisplayValue('유지할 제목')).toBeTruthy()
  expect(mockReviewMounts).toBe(1)
  await act(async () => fireEvent.press(screen.getByLabelText('검토 실행')))
  expect(props.onOpenReview).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 5, program: selection }))
})

test.each(['NEEDS_PROGRAM', 'UNSUPPORTED', 'PARTNERS'] as const)('%s remains explicit without inventing a selected program or search', async outcome => {
  client.sendGovAgentMessage.mockResolvedValue({ outcome, message: '지원 기능을 확인하세요.', ...(outcome === 'PARTNERS' ? { partnerConditions: emptyPartnerRecruitmentConditions } : {}) })
  render(<ChatScreen {...props} />); await send('선택 없는 요청')
  expect(screen.getByText('지원 기능을 확인하세요.')).toBeTruthy()
  expect(screen.queryByTestId('gov-agent-selected-program')).toBeNull()
  expect(client.search).not.toHaveBeenCalled()
  expect(client.interpretConversation).not.toHaveBeenCalled()
  if (outcome === 'PARTNERS') {
    expect(recommendRecruitments).toHaveBeenCalledWith(emptyPartnerRecruitmentConditions, 'admin-session', expect.any(AbortSignal))
    expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![4].messages.at(-1)!.govPartners?.conditions).toEqual(emptyPartnerRecruitmentConditions)
    fireEvent.press(screen.getByLabelText('파트너 관리에서 전체 보기')); expect(props.onOpenPartners).toHaveBeenCalledTimes(1)
  }
})

test.each(['cancel', 'role', 'account'] as const)('a delayed Gov response is discarded after %s', async change => {
  let finish!: (value: GovAgentResult) => void
  client.sendGovAgentMessage.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<ChatScreen {...props} />)
  fireEvent.changeText(screen.getByLabelText('회사 상황이나 궁금한 점'), '늦은 요청')
  fireEvent.press(screen.getByLabelText('AI에게 보내기'))
  const signal = client.sendGovAgentMessage.mock.calls[0][1] as AbortSignal
  if (change === 'cancel') fireEvent.press(screen.getByLabelText('요청 취소'))
  else { auth(change === 'role' ? 'USER' : 'ADMIN', change === 'role' ? 'admin-session' : 'other-session'); view.rerender(<ChatScreen {...props} />) }
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ outcome: 'PARTNERS', message: '폐기할 답변', partnerConditions: emptyPartnerRecruitmentConditions }))
  expect(screen.queryByText('폐기할 답변')).toBeNull()
  expect(saveChatConversation).not.toHaveBeenCalled()
})

test.each([403, 504])('HTTP %s keeps a safe error and the draft without a member-search fallback', async status => {
  const text = status === 403 ? 'Gov 에이전트는 로그인한 관리자만 이용할 수 있습니다.' : 'Gov 에이전트 응답 시간이 초과되었습니다. 다시 요청해 주세요.'
  client.sendGovAgentMessage.mockRejectedValue(new GovAgentApiError(text, status))
  render(<ChatScreen {...props} />); await send('유지할 요청')
  expect(screen.getByText(text)).toBeTruthy()
  expect(screen.getByDisplayValue('유지할 요청')).toBeTruthy()
  expect(client.interpretConversation).not.toHaveBeenCalled()
  if (status === 504) {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    fireEvent.press(screen.getByLabelText('다시 시도'))
    expect(alert).toHaveBeenCalledWith('같은 요청을 다시 보낼까요?', expect.any(String), expect.any(Array))
    expect(client.sendGovAgentMessage).toHaveBeenCalledTimes(1)
  }
})

test('expired bearer authentication invalidates the mobile session', async () => {
  const current = auth()
  client.sendGovAgentMessage.mockRejectedValue(new ApiError(401, '로그인이 만료되었습니다.'))
  render(<ChatScreen {...props} />); await send('만료된 요청')
  expect(current.invalidateSession).toHaveBeenCalledTimes(1)
})

test.each(['ADMIN', 'USER'] as const)('restoring a Gov record as %s makes no AI call and applies current permission', async role => {
  auth(role)
  const snapshot = chatSnapshot([{ id: 'q', role: 'user', text: '저장한 요청' },
    { id: 'a', role: 'assistant', text: '저장한 안내', govReview: { program: selection, message: '저장한 검토', reviewId: 5 } }], emptyChatContext, null, null, selection)
  jest.mocked(getChatConversation).mockResolvedValue({ conversation: { id: 'record', title: 'Gov 기록', version: 1, updatedAt: '2026-10-13T09:00:00' }, snapshot })
  render(<ChatScreen {...props} />)
  await act(async () => fireEvent.press(screen.getByLabelText('대화 기록')))
  const record = await screen.findByLabelText('대화 열기: Gov 기록')
  await act(async () => fireEvent.press(record))
  expect(screen.getByText('저장한 안내')).toBeTruthy()
  expect(client.sendGovAgentMessage).not.toHaveBeenCalled()
  expect(mockReviewMounts).toBe(0)
  if (role === 'ADMIN') {
    fireEvent.press(screen.getByLabelText('중복 검토 화면에서 이어서 보기'))
    expect(props.onOpenReview).toHaveBeenCalledWith(snapshot.messages[1].govReview)
    fireEvent.press(screen.getByLabelText('새 대화'))
    expect(screen.queryByTestId('gov-agent-selected-program')).toBeNull()
  } else expect(screen.queryByLabelText('중복 검토 화면에서 이어서 보기')).toBeNull()
})

test('a confirmed new search clears the previous selection from UI and history', async () => {
  render(<ChatScreen {...props} />); await select(); await send('다른 공고를 찾아줘')
  await act(async () => fireEvent.press(screen.getByLabelText('이 조건으로 검색')))
  expect(screen.queryByTestId('gov-agent-selected-program')).toBeNull()
  expect(jest.mocked(saveChatConversation).mock.calls.at(-1)![4].govProgram).toBeNull()
})
