import { vi } from 'vitest'

// 작업 화면 틀이 사이드바 배지를 위해 읽는 분석·초안 작업 목록이 다른 기능 테스트의 순차 fetch 응답을 소비하지 않게 경계만 격리합니다.
// 작업 목록 읽기와 목록 화면의 통합 테스트는 이 mock을 해제해 실제 동작을 별도로 검증합니다.
vi.mock('../presentation/shared/preparation-jobs/PreparationJobsSync', () => ({ PreparationJobsSync: () => null }))
