import { appPaths, readSavedProgramsViewMode, savedProgramsPath } from '../../../shared/routes/appPaths'
import { readCatalogFilters, writeCatalogFilters } from '../../../shared/support-program/catalogSearchParams'

/** 비로그인 상세·질문 주소에 검색 복귀 경로를 담는 쿼리 이름입니다. */
export const BACK_PARAM = 'back'

export type SupportProgramSearchReturnTo =
  | '/'
  | typeof appPaths.chat
  | typeof appPaths.savedPrograms
  | `/?${string}`
  | `${typeof appPaths.chat}?${string}`
  | `${typeof appPaths.savedPrograms}?view=${string}`

/**
 * 두 검색 경로와 검증된 필터만 복원합니다. 외부 URL·임의 경로는 허용하지 않습니다.
 * 이동 상태가 없으면(새로고침·공유 URL) 비로그인 링크가 주소에 실어 둔 `back`을 같은 규칙으로 읽습니다.
 */
export function getSupportProgramSearchReturnTo(state: unknown, search = ''): SupportProgramSearchReturnTo {
  const fromState = typeof state === 'object' && state !== null && 'searchReturnTo' in state && typeof state.searchReturnTo === 'string'
    ? state.searchReturnTo : null
  const value = fromState ?? new URLSearchParams(search).get(BACK_PARAM)
  if (value === null) return '/'
  if (value === '/' || value === appPaths.chat || value === appPaths.savedPrograms) return value
  const queryIndex = value.indexOf('?')
  const path = value.slice(0, queryIndex)
  if (queryIndex < 0 || value.includes('#')) return '/'
  const params = new URLSearchParams(value.slice(queryIndex + 1))
  // 관심 공고함은 보던 탭만 되살립니다. 모르는 탭 이름이면 기본 탭인 달력으로 돌아갑니다.
  if (path === appPaths.savedPrograms) return savedProgramsPath(readSavedProgramsViewMode(params.get('view'))) as SupportProgramSearchReturnTo
  if (path !== '/' && path !== appPaths.chat) return '/'
  if (params.get('mode') !== 'filter') return '/'
  return `${path}?${writeCatalogFilters(readCatalogFilters(params))}`
}

/** 상세 위 돌아가기 링크 문구입니다. 관심 공고함에서 열었으면 관심 공고함으로, 아니면 검색 결과로 돌아갑니다. */
export function supportProgramBackLabel(returnTo: SupportProgramSearchReturnTo): string {
  return returnTo.startsWith(appPaths.savedPrograms) ? '← 관심 공고함으로 돌아가기' : '← 검색 결과로 돌아가기'
}

/**
 * 진행 관리 파이프라인(준비 중~탈락)에서 넘어온 상세인지 나타냅니다. 그 공고는 신청을 준비 중인 사업이라
 * 관심 공고함에서 빼면 진행 관리에서도 보이지 않게 되므로, 빼기 전에 확인을 받는 데 씁니다.
 */
export function getSupportProgramFromPipeline(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'fromPipeline' in state && state.fromPipeline === true
}
