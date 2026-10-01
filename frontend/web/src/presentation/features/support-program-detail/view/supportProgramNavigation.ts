import { appPaths, readSavedProgramsViewMode, savedProgramsPath } from '../../../shared/routes/appPaths'
import { readCatalogFilters, writeCatalogFilters } from '../../../shared/support-program/catalogSearchParams'

/** 비로그인 상세·질문 주소에 검색 복귀 경로를 담는 쿼리 이름입니다. */
export const BACK_PARAM = 'back'

export type SupportProgramSearchReturnTo =
  | '/'
  | typeof appPaths.chat
  | typeof appPaths.savedPrograms
  | typeof appPaths.applicationPreparations
  | typeof appPaths.reports
  | `/?${string}`
  | `${typeof appPaths.chat}?${string}`
  | `${typeof appPaths.savedPrograms}?view=${string}`
  | `${typeof appPaths.applicationPreparations}?status=${string}`

/**
 * 두 검색 경로·관심 공고함·신청 문서 목록·기업 맞춤 리포트와 검증된 필터만 복원합니다. 외부 URL·임의 경로는 허용하지 않습니다.
 * 이동 상태가 없으면(새로고침·공유 URL) 비로그인 링크가 주소에 실어 둔 `back`을 같은 규칙으로 읽습니다.
 */
export function getSupportProgramSearchReturnTo(state: unknown, search = ''): SupportProgramSearchReturnTo {
  const fromState = typeof state === 'object' && state !== null && 'searchReturnTo' in state && typeof state.searchReturnTo === 'string'
    ? state.searchReturnTo : null
  const value = fromState ?? new URLSearchParams(search).get(BACK_PARAM)
  if (value === null) return '/'
  if (value === '/' || value === appPaths.chat || value === appPaths.savedPrograms || value === appPaths.applicationPreparations || value === appPaths.reports) return value
  const queryIndex = value.indexOf('?')
  const path = value.slice(0, queryIndex)
  if (queryIndex < 0 || value.includes('#')) return '/'
  const params = new URLSearchParams(value.slice(queryIndex + 1))
  // 리포트는 되살릴 조건이 없어 쿼리를 버리고 화면만 되돌립니다.
  if (path === appPaths.reports) return appPaths.reports
  // 관심 공고함은 보던 탭만 되살립니다. 모르는 탭 이름이면 기본 탭인 목록으로 돌아갑니다.
  if (path === appPaths.savedPrograms) return savedProgramsPath(readSavedProgramsViewMode(params.get('view'))) as SupportProgramSearchReturnTo
  // 신청 문서 목록은 보던 상태 필터(진행 중 · 완료)만 되살립니다. 모르는 값이면 전체 목록으로 돌아갑니다.
  if (path === appPaths.applicationPreparations) {
    const status = params.get('status')
    return status === 'in_progress' || status === 'done' ? `${appPaths.applicationPreparations}?status=${status}` : appPaths.applicationPreparations
  }
  if (path !== '/' && path !== appPaths.chat) return '/'
  if (params.get('mode') !== 'filter') return '/'
  return `${path}?${writeCatalogFilters(readCatalogFilters(params))}`
}

/** 관심 공고함에서 연 상세인지입니다. 머리글과 사이드바 활성 항목이 이것으로 갈립니다. */
export function isSavedProgramsReturnTo(returnTo: SupportProgramSearchReturnTo): boolean {
  return returnTo.startsWith(appPaths.savedPrograms)
}

/** 신청 문서 목록의 카드 메뉴에서 연 상세인지입니다. 사이드바 활성 항목이 이것으로 갈립니다. */
export function isApplicationPreparationsReturnTo(returnTo: SupportProgramSearchReturnTo): boolean {
  return returnTo.startsWith(appPaths.applicationPreparations)
}

/** 기업 맞춤 리포트의 추천 카드에서 연 상세인지입니다. 사이드바 활성 항목이 이것으로 갈립니다. */
export function isReportsReturnTo(returnTo: SupportProgramSearchReturnTo): boolean {
  return returnTo === appPaths.reports
}

/** 검색이 아닌 작업 목록(관심 공고함 · 신청 문서 목록 · 기업 맞춤 리포트)에서 연 상세인지입니다. 검색 탭 줄 대신 머리글 높이의 돌아가기 줄을 씁니다. */
export function isWorkspaceListReturnTo(returnTo: SupportProgramSearchReturnTo): boolean {
  return isSavedProgramsReturnTo(returnTo) || isApplicationPreparationsReturnTo(returnTo) || isReportsReturnTo(returnTo)
}

/** 상세 위 돌아가기 링크 문구입니다. 연 곳(관심 공고함 · 신청 문서 목록 · 기업 맞춤 리포트 · 검색 결과)으로 돌아간다고 말합니다. 화살표는 아이콘이 맡습니다. */
export function supportProgramBackLabel(returnTo: SupportProgramSearchReturnTo): string {
  if (isSavedProgramsReturnTo(returnTo)) return '관심 공고함으로 돌아가기'
  if (isApplicationPreparationsReturnTo(returnTo)) return '신청 문서 작성으로 돌아가기'
  if (isReportsReturnTo(returnTo)) return '기업 맞춤 리포트로 돌아가기'
  return '검색 결과로 돌아가기'
}

/**
 * 진행 관리 파이프라인(준비 중~탈락)에서 넘어온 상세인지 나타냅니다. 그 공고는 신청을 준비 중인 사업이라
 * 관심 공고함에서 빼면 진행 관리에서도 보이지 않게 되므로, 빼기 전에 확인을 받는 데 씁니다.
 */
export function getSupportProgramFromPipeline(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'fromPipeline' in state && state.fromPipeline === true
}
