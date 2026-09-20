import { createSelector, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'

import type { SampleItemPreparation } from '../../../../domain/entities/SampleItemPreparation'
import {
  sampleItemFormSchema,
  type SampleItemFormValues,
} from '../validation/sampleItemFormSchema'

type SampleItemStatus = 'idle' | 'pending' | 'succeeded' | 'failed'

type SampleItemState = {
  activeRequestId: string | null
  error: string | null
  isRetrying: boolean
  preparation: SampleItemPreparation | null
  status: SampleItemStatus
  touched: Record<keyof SampleItemFormValues, boolean>
  values: SampleItemFormValues
}

type SampleItemStateContainer = {
  sampleItem: SampleItemState
}

const initialState: SampleItemState = createInitialState()

/** Redux 비교 화면의 직렬화 가능한 폼·요청 상태를 소유합니다. */
const sampleItemSlice = createSlice({
  name: 'sampleItem',
  initialState,
  reducers: {
    categoryChanged(state, action: PayloadAction<SampleItemFormValues['category']>) {
      state.values.category = action.payload
      state.touched.category = true
      clearPreviousOutcome(state)
    },
    nameChanged(state, action: PayloadAction<string>) {
      state.values.name = action.payload
      state.touched.name = true
      clearPreviousOutcome(state)
    },
    noteChanged(state, action: PayloadAction<string>) {
      state.values.note = action.payload
      state.touched.note = true
      clearPreviousOutcome(state)
    },
    preparationCancelled(state, action: PayloadAction<{ requestId: string }>) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.error = null
      state.isRetrying = false
      state.status = 'idle'
    },
    preparationFailed(state, action: PayloadAction<{ requestId: string; message?: string }>) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.error = action.payload.message
        ?? 'Core API에 Redux 예제 요청을 전달하지 못했습니다. Core API 상태를 확인한 뒤 다시 요청해 주세요.'
      state.status = 'failed'
    },
    preparationStarted: {
      reducer(state, action: PayloadAction<{ requestId: string }>) {
        if (state.status === 'pending') return
        state.activeRequestId = action.payload.requestId
        state.error = null
        state.isRetrying = state.status === 'failed'
        state.preparation = null
        state.status = 'pending'
      },
      prepare() {
        return { payload: { requestId: nanoid() } }
      },
    },
    preparationSucceeded(
      state,
      action: PayloadAction<{ preparation: SampleItemPreparation; requestId: string }>,
    ) {
      if (state.activeRequestId !== action.payload.requestId) return
      state.activeRequestId = null
      state.error = null
      state.isRetrying = false
      state.preparation = action.payload.preparation
      state.status = 'succeeded'
    },
    sampleItemReset() {
      return createInitialState()
    },
  },
})

export const {
  categoryChanged,
  nameChanged,
  noteChanged,
  preparationCancelled,
  preparationFailed,
  preparationStarted,
  preparationSucceeded,
  sampleItemReset,
} = sampleItemSlice.actions

export const selectSampleItemState = (state: SampleItemStateContainer) => state.sampleItem
export const selectSampleItemValues = (state: SampleItemStateContainer) => state.sampleItem.values
export const selectSampleItemPreparation = (state: SampleItemStateContainer) =>
  state.sampleItem.preparation
export const selectSampleItemError = (state: SampleItemStateContainer) => state.sampleItem.error
export const selectIsSampleItemPreparing = (state: SampleItemStateContainer) =>
  state.sampleItem.status === 'pending'

const selectSampleItemValidation = createSelector(
  [selectSampleItemValues],
  (values) => sampleItemFormSchema.safeParse(values),
)

export const selectSampleItemErrors = createSelector(
  [selectSampleItemValidation, selectSampleItemState],
  (validation, state) => {
    const errors: Partial<Record<keyof SampleItemFormValues, string>> = {}
    if (validation.success) return errors

    for (const issue of validation.error.issues) {
      const field = issue.path[0]
      if (!isSampleItemField(field) || !state.touched[field] || errors[field]) continue
      errors[field] = issue.message
    }
    return errors
  },
)

export const selectIsSampleItemReady = createSelector(
  [selectSampleItemValidation, selectIsSampleItemPreparing],
  (validation, isPreparing) => validation.success && !isPreparing,
)

export const selectSampleItemActionMessage = createSelector(
  [selectSampleItemValidation, selectSampleItemState],
  (validation, state) => {
    if (state.status === 'pending') return 'Redux가 Core API 요청 상태를 관리하고 있습니다.'
    if (state.status === 'failed') return '요청이 실패했습니다. 아래 버튼으로 다시 요청할 수 있습니다.'
    if (state.status === 'succeeded') return 'Redux Store에 성공 결과가 저장되었습니다.'
    if (validation.success) return 'Redux 예제 요청을 보낼 수 있습니다.'
    return '이름을 입력하면 준비됩니다.'
  },
)

export const selectSampleItemButtonLabel = createSelector(
  [selectSampleItemState],
  (state) => {
    if (state.status === 'pending') return state.isRetrying ? '다시 요청 중…' : '요청 중…'
    if (state.status === 'failed') return '다시 요청'
    return state.status === 'succeeded' ? '다시 확인' : '준비 상태 확인'
  },
)

export default sampleItemSlice.reducer

function clearPreviousOutcome(state: SampleItemState) {
  state.activeRequestId = null
  state.error = null
  state.isRetrying = false
  state.preparation = null
  state.status = 'idle'
}

function createInitialState(): SampleItemState {
  return {
    activeRequestId: null,
    error: null,
    isRetrying: false,
    preparation: null,
    status: 'idle',
    touched: {
      category: false,
      name: false,
      note: false,
    },
    values: {
      category: '',
      name: '',
      note: '',
    },
  }
}

function isSampleItemField(value: PropertyKey): value is keyof SampleItemFormValues {
  return value === 'category' || value === 'name' || value === 'note'
}
