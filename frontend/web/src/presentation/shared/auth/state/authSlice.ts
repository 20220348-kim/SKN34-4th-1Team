import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import type { RootState } from '../../../../app/store'
import type { Account } from '../../../../domain/entities/Account'

/** `unknown`은 앱 시작 직후 저장된 세션을 아직 확인하지 않은 상태입니다. */
export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

type AuthState = {
  status: AuthStatus
  account: Account | null
}

const initialState: AuthState = {
  status: 'unknown',
  account: null,
}

/** 로그인 상태는 헤더와 여러 화면이 함께 읽으므로 특정 feature가 아닌 shared에 둡니다. */
const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionRestored(state, action: PayloadAction<Account | null>) {
      state.account = action.payload
      state.status = action.payload ? 'authenticated' : 'anonymous'
    },
    signedIn(state, action: PayloadAction<Account>) {
      state.account = action.payload
      state.status = 'authenticated'
    },
    signedOut(state) {
      state.account = null
      state.status = 'anonymous'
    },
  },
})

export const { sessionRestored, signedIn, signedOut } = authSlice.actions

export const selectAuthStatus = (state: RootState) => state.auth.status
export const selectCurrentAccount = (state: RootState) => state.auth.account
export const selectIsAuthenticated = (state: RootState) => state.auth.status === 'authenticated'

export default authSlice.reducer
