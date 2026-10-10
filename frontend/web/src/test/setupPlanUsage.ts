import { vi } from 'vitest'

// 검색·질문·검토·초안·프로필 화면이 따로 읽는 요금제 이용량이 다른 기능 테스트의 순차 fetch 응답을 소비하지 않게 경계만 격리합니다.
// 응답이 오지 않으므로 이용량 줄은 그려지지 않습니다. 이용량 API 테스트는 이 mock을 해제하고, 화면 테스트는 UseCase를 직접 넣어 검증합니다.
vi.mock('../data/api/planUsageApi', async (importOriginal) => ({
  ...await importOriginal<object>(),
  planUsageRequest: () => new Promise(() => {}),
}))
