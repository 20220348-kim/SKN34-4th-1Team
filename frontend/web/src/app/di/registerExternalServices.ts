import { asValue } from 'awilix/browser'

import { fetchCoreApiHealth } from '../../data/api/fetchCoreApiHealth'
import { isAssistantAiEnabled } from '../../data/config/assistantAi'
import { kakaoChannelChatUrl } from '../../data/config/kakaoChannel'
import { createLocalSessionHintStorage } from '../../data/storage/sessionHintStorage'
import type { AppContainer } from './types'

/** UseCase가 아닌 외부 API·브라우저 저장소 기능을 애플리케이션 컨테이너에 등록합니다. */
export function registerExternalServices(container: AppContainer) {
  container.register({
    fetchCoreApiHealth: asValue(fetchCoreApiHealth),
    kakaoChannelChatUrl: asValue(kakaoChannelChatUrl),
    isAssistantAiEnabled: asValue(isAssistantAiEnabled),
    sessionHintStorage: asValue(createLocalSessionHintStorage()),
  })
}
