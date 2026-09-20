// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { createAppStore } from '../../../app/store'
import { emptyConversationContext, readyConversationProposal, seoulConversationContext } from '../../../data/fixtures/supportProgramConversation'
import { emptyConversationContext as answeredContext } from '../../../data/fixtures/supportProgramConversation'
import { interpretationStarted, interpretationSucceeded, outcomeSeen } from '../../features/chat/state/chatSlice'
import { appPaths } from '../routes/appPaths'
import { ChatActivityToast } from './ChatActivityToast'

afterEach(cleanup)

describe('검색 결과 도착 토스트', () => {
  it('닫은 뒤 결과를 보고 다음 요청의 같은 종류 결과가 오면 다시 알린다', () => {
    const store = createAppStore()
    render(<Provider store={store}><MemoryRouter initialEntries={[appPaths.partners]}><ChatActivityToast /></MemoryRouter></Provider>)

    const first = interpretationStarted({ message: '서울 AI', context: emptyConversationContext }, 'first')
    act(() => {
      store.dispatch(first)
      store.dispatch(interpretationSucceeded({ requestId: first.payload.requestId, result: readyConversationProposal(seoulConversationContext) }))
    })
    expect(screen.getByRole('status', { name: '검색 알림' }).textContent).toContain('조건 변경안이 준비됐어요')
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(screen.queryByRole('status', { name: '검색 알림' })).toBeNull()

    act(() => store.dispatch(outcomeSeen()))
    const second = interpretationStarted({ message: '부산 제조', context: emptyConversationContext }, 'second')
    act(() => {
      store.dispatch(second)
      store.dispatch(interpretationSucceeded({ requestId: second.payload.requestId, result: readyConversationProposal(seoulConversationContext) }))
    })
    expect(screen.getByRole('status', { name: '검색 알림' })).toBeTruthy()
  })

  it('답변 도착은 토스트를 띄우지 않는다', () => {
    const store = createAppStore()
    render(<Provider store={store}><MemoryRouter initialEntries={[appPaths.partners]}><ChatActivityToast /></MemoryRouter></Provider>)
    const started = interpretationStarted({ message: '지원 목적이 뭐야', context: answeredContext }, 'answered')
    act(() => {
      store.dispatch(started)
      store.dispatch(interpretationSucceeded({ requestId: started.payload.requestId, result: {
        status: 'ANSWERED', answer: '지원 목적은 사업화입니다.', proposedContext: answeredContext, clarificationQuestion: null, changedFields: [],
      } }))
    })
    expect(store.getState().chat.unseenOutcome).toBe('interpretation-answered')
    expect(screen.queryByRole('status', { name: '검색 알림' })).toBeNull()
  })
})
