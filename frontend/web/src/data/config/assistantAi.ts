/**
 * 도우미 자유 질문을 AI(Core 도우미 API → AI Service)로 보낼지 정하는 빌드 환경값입니다.
 * `VITE_ASSISTANT_AI_ENABLED=true`일 때만 켜지고, 그 밖에는 자유 입력을 주제 알약으로 돌려보내 모델 비용이 들지 않습니다.
 * 환경값 읽기는 `coreApiConfig`처럼 data 계층에 두고, 화면은 DI로 받은 함수만 부릅니다.
 */
export function isAssistantAiEnabled(): boolean {
  return (import.meta.env.VITE_ASSISTANT_AI_ENABLED ?? '').trim().toLowerCase() === 'true'
}

export type IsAssistantAiEnabled = typeof isAssistantAiEnabled
