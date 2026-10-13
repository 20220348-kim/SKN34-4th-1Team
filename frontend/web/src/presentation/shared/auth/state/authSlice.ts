import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import type { RootState } from '../../../../app/store'
import type { Account } from '../../../../domain/entities/Account'

/** `unknown`은 앱 시작 직후 저장된 세션을 아직 확인하지 않은 상태입니다. */
export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

/**
 * 사용자가 직접 로그아웃하지 않았는데 로그인이 끝난 이유입니다. 로그인 화면이 한 줄로 알립니다.
 * `expired`는 서버가 세션을 받아 주지 않은 경우(만료·강제 로그아웃·정지), `elsewhere`는 다른 창에서 로그아웃한 경우입니다.
 */
export type SessionEndReason = 'expired' | 'elsewhere'

type AuthState = {
  status: AuthStatus
  account: Account | null
  endReason: SessionEndReason | null
}

const initialState: AuthState = {
  status: 'unknown',
  account: null,
  endReason: null,
}

/** 로그인 상태는 헤더와 여러 화면이 함께 읽으므로 특정 feature가 아닌 shared에 둡니다. */
const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionRestored(state, action: PayloadAction<Account | null>) {
      state.account = action.payload
      state.status = action.payload ? 'authenticated' : 'anonymous'
      if (action.payload) state.endReason = null
    },
    signedIn(state, action: PayloadAction<Account>) {
      state.account = action.payload
      state.status = 'authenticated'
      state.endReason = null
    },
    /** 직접 로그아웃하면 이유 없이, 세션이 끝나 로그아웃시키면 이유와 함께 보냅니다. 회원 데이터 정리는 같은 액션으로 합니다. */
    signedOut: {
      reducer(state, action: PayloadAction<SessionEndReason | undefined>) {
        state.account = null
        state.status = 'anonymous'
        state.endReason = action.payload ?? null
      },
      prepare(reason?: SessionEndReason) {
        return { payload: reason }
      },
    },
  },
})

export const { sessionRestored, signedIn, signedOut } = authSlice.actions

export const selectAuthStatus = (state: RootState) => state.auth.status
export const selectCurrentAccount = (state: RootState) => state.auth.account
export const selectIsAuthenticated = (state: RootState) => state.auth.status === 'authenticated'
export const selectSessionEndReason = (state: RootState) => state.auth.endReason

export default authSlice.reducer
