import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import type { AssistantMessage, AssistantQuickReply } from '../assistantConversation'
import { sessionRestored, signedIn, signedOut } from '../../auth/state/authSlice'

/** 같은 계정의 같은 탭에서만 복원합니다. 계정 정보 없는 구버전 캐시는 사용하지 않습니다. */
export const assistantConversationStorageKey = 'govbiz.assistant.conversation'

export type AssistantSession = { accountEmail: string | null; sessionVersion: number }
export type AssistantConversation = { messages: AssistantMessage[]; quickReplies: AssistantQuickReply[] }
export type AssistantState = AssistantSession & AssistantConversation & {
  authResolved: boolean
  initialized: boolean
}

const initialState: AssistantState = {
  accountEmail: null, sessionVersion: 0, authResolved: false, initialized: false,
  messages: [], quickReplies: [],
}

function resetSession(state: AssistantState, accountEmail: string | null): AssistantState {
  return { ...initialState, accountEmail, authResolved: true, initialized: true, sessionVersion: state.sessionVersion + 1 }
}

function isCurrentSession(state: AssistantState, session: AssistantSession): boolean {
  return state.authResolved && state.accountEmail === session.accountEmail && state.sessionVersion === session.sessionVersion
}

const assistantSlice = createSlice({
  name: 'assistant',
  initialState,
  reducers: {
    assistantConversationRestored(state, action: PayloadAction<AssistantSession & AssistantConversation>) {
      if (state.initialized || !isCurrentSession(state, action.payload)) return
      state.messages = action.payload.messages
      state.quickReplies = action.payload.quickReplies
      state.initialized = true
    },
    assistantConversationReplaced(state, action: PayloadAction<AssistantSession & AssistantConversation>) {
      if (!isCurrentSession(state, action.payload)) return
      state.messages = action.payload.messages
      state.quickReplies = action.payload.quickReplies
      state.initialized = true
    },
    assistantMessagesAdded(state, action: PayloadAction<AssistantSession & AssistantConversation>) {
      if (!isCurrentSession(state, action.payload)) return
      state.messages.push(...action.payload.messages)
      state.quickReplies = action.payload.quickReplies
      state.initialized = true
    },
    assistantQuickRepliesChanged(state, action: PayloadAction<AssistantSession & { quickReplies: AssistantQuickReply[] }>) {
      if (!isCurrentSession(state, action.payload)) return
      state.quickReplies = action.payload.quickReplies
    },
  },
  extraReducers: (builder) => {
    builder
      // 같은 계정으로 즉시 다시 로그인해도 이전 로그인에서 시작한 응답을 받지 않습니다.
      .addCase(signedOut, (state) => resetSession(state, null))
      .addCase(signedIn, (state, action) => resetSession(state, action.payload.email))
      .addCase(sessionRestored, (state, action) => {
        const accountEmail = action.payload?.email ?? null
        if (state.authResolved && state.accountEmail !== accountEmail) return resetSession(state, accountEmail)
        state.accountEmail = accountEmail
        state.authResolved = true
      })
  },
})

export const {
  assistantConversationRestored, assistantConversationReplaced, assistantMessagesAdded, assistantQuickRepliesChanged,
} = assistantSlice.actions
export default assistantSlice.reducer
