import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import type { RootState } from '../../../../app/store'
import type { ApplicationDocumentGenerationJob, ApplicationFormDiscoveryJob } from '../../../../domain/entities/ApplicationPreparation'
import { sessionRestored, signedIn, signedOut } from '../../auth/state/authSlice'

/**
 * 계정의 최근 양식 분석 · 문서 생성 작업의 서버 사본입니다. 사이드바 배지와 신청 문서 목록이 함께 읽으므로 Hook 로컬이 아니라
 * Redux에 둡니다. `accountEmail`은 어느 계정의 작업인지이며 다른 계정으로 바뀌면 비웁니다.
 * `refreshToken`은 화면이 작업을 새로 시작했거나 결과를 확인했을 때 올려, 다음 주기를 기다리지 않고 다시 읽게 합니다.
 */
type PreparationJobsState = {
  accountEmail: string | null
  analysisJobs: ApplicationFormDiscoveryJob[]
  documentJobs: ApplicationDocumentGenerationJob[]
  /** 마지막으로 읽은 시각(ms)입니다. 경과 시간과 "하루 안" 판정의 기준입니다. */
  readAt: number
  refreshToken: number
}

const initialState: PreparationJobsState = { accountEmail: null, analysisJobs: [], documentJobs: [], readAt: 0, refreshToken: 0 }

const preparationJobsSlice = createSlice({
  name: 'preparationJobs',
  initialState,
  reducers: {
    /** 읽지 못한 쪽(null)은 이전 값을 그대로 둡니다. 한쪽 조회 실패가 다른 쪽 표시를 지우지 않습니다. */
    preparationJobsLoaded(state, action: PayloadAction<{
      accountEmail: string
      analysisJobs: ApplicationFormDiscoveryJob[] | null
      documentJobs: ApplicationDocumentGenerationJob[] | null
      readAt: number
    }>) {
      if (state.accountEmail !== action.payload.accountEmail) {
        state.analysisJobs = []
        state.documentJobs = []
      }
      state.accountEmail = action.payload.accountEmail
      if (action.payload.analysisJobs !== null) state.analysisJobs = action.payload.analysisJobs
      if (action.payload.documentJobs !== null) state.documentJobs = action.payload.documentJobs
      state.readAt = action.payload.readAt
    },
    preparationJobsRefreshRequested(state) {
      state.refreshToken += 1
    },
  },
  extraReducers: (builder) => {
    // 로그아웃하거나 다른 계정으로 바뀌면 이전 계정의 작업을 남기지 않습니다.
    builder
      .addCase(signedOut, () => initialState)
      .addCase(signedIn, (state, action) => (state.accountEmail === action.payload.email ? state : initialState))
      .addCase(sessionRestored, (state, action) => (action.payload !== null && state.accountEmail === action.payload.email ? state : initialState))
  },
})

export const { preparationJobsLoaded, preparationJobsRefreshRequested } = preparationJobsSlice.actions

export const selectPreparationAnalysisJobs = (state: RootState) => state.preparationJobs.analysisJobs
export const selectPreparationDocumentJobs = (state: RootState) => state.preparationJobs.documentJobs
export const selectPreparationJobsReadAt = (state: RootState) => state.preparationJobs.readAt
export const selectPreparationJobsRefreshToken = (state: RootState) => state.preparationJobs.refreshToken

export default preparationJobsSlice.reducer
