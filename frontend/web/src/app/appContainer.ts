import { createAppContainer } from './di/container'

/** GetIt처럼 앱 어디서나 같은 의존성을 조회하는 단일 Service Locator입니다. */
export const appContainer = createAppContainer()
