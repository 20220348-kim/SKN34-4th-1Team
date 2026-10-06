import { configureStore, createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit'

import chatReducer from '../presentation/features/chat/state/chatSlice'
import { ChatRequestRegistry } from '../presentation/features/chat/state/chatRequestRegistry'
import authReducer, { sessionRestored, signedIn, signedOut } from '../presentation/shared/auth/state/authSlice'
import { readAssistantConversation, writeAssistantConversation } from '../presentation/shared/assistant/assistantConversationStorage'
import assistantReducer, {
  type AssistantState,
} from '../presentation/shared/assistant/state/assistantSlice'
import receivedProposalsReducer from '../presentation/shared/partner-proposal/state/receivedProposalsSlice'
import preparationJobsReducer from '../presentation/shared/preparation-jobs/state/preparationJobsSlice'
import sampleItemReducer from '../presentation/features/sample-item/state/sampleItemSlice'

/** thunk의 세 번째 인자입니다. 진행 중인 채팅 요청은 화면이 아니라 스토어와 함께 삽니다. */
export type AppThunkExtra = ChatRequestRegistry

export function createAppStore() {
  const chatRequests = new ChatRequestRegistry()
  const assistantAuthCleanup = createListenerMiddleware()
  assistantAuthCleanup.startListening({
    matcher: isAnyOf(signedOut, signedIn, sessionRestored),
    effect: (_action, api) => {
      const previous = api.getOriginalState() as { assistant: AssistantState }
      const current = api.getState() as { assistant: AssistantState }
      if (previous.assistant.sessionVersion !== current.assistant.sessionVersion) {
        // 위젯이 숨겨져 있거나 마운트되지 않아도 인증 이벤트에서 대화 캐시를 지웁니다.
        writeAssistantConversation(null)
      } else if (!previous.assistant.authResolved && readAssistantConversation(current.assistant.accountEmail) === null) {
        // 처음 인증을 복원할 때도 다른 소유자·구버전 캐시는 즉시 삭제합니다. 같은 소유자의 캐시는 유지합니다.
        writeAssistantConversation(null)
      }
    },
  })
  return configureStore({
    reducer: {
      auth: authReducer,
      assistant: assistantReducer,
      chat: chatReducer,
      preparationJobs: preparationJobsReducer,
      receivedProposals: receivedProposalsReducer,
      sampleItem: sampleItemReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ thunk: { extraArgument: chatRequests } }).prepend(assistantAuthCleanup.middleware),
  })
}

export type AppStore = ReturnType<typeof createAppStore>
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']
