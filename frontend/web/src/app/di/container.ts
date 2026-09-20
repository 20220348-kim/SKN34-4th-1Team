import { createContainer, InjectionMode } from 'awilix/browser'

import { registerExternalServices } from './registerExternalServices'
import { registerRepositories } from './registerRepositories'
import { registerUseCases } from './registerUseCases'
import type { AppContainer, AppCradle } from './types'

/** 역할별 등록 모듈을 하나의 애플리케이션 객체 graph로 조립합니다. */
export function createAppContainer(): AppContainer {
  const container = createContainer<AppCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  })

  registerRepositories(container)
  registerUseCases(container)
  registerExternalServices(container)

  return container
}
