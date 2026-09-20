import { browseSupportProgramsApi } from './supportProgramCatalogApi'
import {
  answerSupportProgramEvidenceQuestionApi,
  getSupportProgramDetailApi,
  getSupportProgramSearchReadinessApi,
  interpretSupportProgramConversationApi,
  restoreSupportProgramSearchApi,
  searchSupportProgramsApi,
} from './supportProgramApi'

export type SupportProgramClientOptions = {
  /** 공개 API 주소만 전달합니다. 웹은 같은 출처의 빈 문자열도 사용할 수 있습니다. */
  baseUrl: string | (() => string)
  /** 검색·검색 복원 요청의 쿠키 정책입니다. 공개 GET의 기존 동작은 유지합니다. */
  credentials?: RequestCredentials
  /** 앱은 세션/시간 제한을 처리하는 fetch를 주입할 수 있습니다. */
  fetch?: typeof globalThis.fetch
}

/** HTTP 구현과 플랫폼의 주소·세션 설정 사이의 작은 경계입니다. */
export type SupportProgramHttpContext = {
  readonly baseUrl: string
  readonly credentials: RequestCredentials
  fetch: typeof globalThis.fetch
}

/** Vite·Expo 환경변수나 브라우저 저장소에 의존하지 않는 공용 클라이언트입니다. */
export function createSupportProgramClient(options: SupportProgramClientOptions) {
  const context: SupportProgramHttpContext = {
    get baseUrl() {
      const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl
      return baseUrl.trim().replace(/\/+$/, '')
    },
    credentials: options.credentials ?? 'omit',
    // 환경과 테스트가 교체한 fetch를 호출 시점에 읽습니다.
    fetch: (...args) => (options.fetch ?? globalThis.fetch)(...args),
  }

  return {
    browseCatalog: browseSupportProgramsApi.bind(null, context),
    getDetail: getSupportProgramDetailApi.bind(null, context),
    search: searchSupportProgramsApi.bind(null, context),
    getSearchReadiness: getSupportProgramSearchReadinessApi.bind(null, context),
    interpretConversation: interpretSupportProgramConversationApi.bind(null, context),
    answerEvidenceQuestion: answerSupportProgramEvidenceQuestionApi.bind(null, context),
    restoreSearch: restoreSupportProgramSearchApi.bind(null, context),
  }
}

export type SupportProgramClient = ReturnType<typeof createSupportProgramClient>
