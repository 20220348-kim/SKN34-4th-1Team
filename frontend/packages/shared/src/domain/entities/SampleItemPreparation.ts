import type { SampleItem } from './SampleItem'

/** 실제 처리가 시작되기 전 Core API가 반환하는 준비 상태입니다. */
export type SampleItemPreparation = {
  phase: 'READY_FOR_PROCESSING'
  item: SampleItem
  processing: {
    status: 'NOT_STARTED'
  }
}
