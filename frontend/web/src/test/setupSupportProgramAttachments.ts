import { vi } from 'vitest'

// 공고 상세가 따로 읽는 공식 첨부 목록이 다른 기능 테스트의 순차 fetch 응답을 소비하지 않게 경계만 격리합니다.
// 첨부 목록 훅과 상세 화면의 첨부 구역 테스트는 이 mock을 해제해 실제 동작을 별도로 검증합니다.
vi.mock('../presentation/features/support-program-detail/viewmodel/useSupportProgramAttachmentsViewModel', async (importOriginal) => ({
  ...await importOriginal<object>(),
  useSupportProgramAttachmentsViewModel: () => ({ status: 'ready', attachments: [] }),
}))
