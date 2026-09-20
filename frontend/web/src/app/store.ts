import { configureStore } from '@reduxjs/toolkit'

import chatReducer from '../presentation/features/chat/state/chatSlice'
import { ChatRequestRegistry } from '../presentation/features/chat/state/chatRequestRegistry'
import authReducer from '../presentation/shared/auth/state/authSlice'
import receivedProposalsReducer from '../presentation/shared/partner-proposal/state/receivedProposalsSlice'
import sampleItemReducer from '../presentation/features/sample-item/state/sampleItemSlice'

/** thunk의 세 번째 인자입니다. 진행 중인 채팅 요청은 화면이 아니라 스토어와 함께 삽니다. */
export type AppThunkExtra = ChatRequestRegistry

export function createAppStore() {
  const chatRequests = new ChatRequestRegistry()
  return configureStore({
    reducer: {
      auth: authReducer,
      chat: chatReducer,
      receivedProposals: receivedProposalsReducer,
      sampleItem: sampleItemReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ thunk: { extraArgument: chatRequests } }),
  })
}

export type AppStore = ReturnType<typeof createAppStore>
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']
