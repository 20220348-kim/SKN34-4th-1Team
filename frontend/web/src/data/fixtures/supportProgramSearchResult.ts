/** 기존 전체 공개 검색 fixture에 새 응답의 필수 메타데이터를 명시합니다. */
export function completeSearchResult<T extends { programs: readonly unknown[] }>(result: T) {
  return { ...result, totalCount: result.programs.length, resultToken: null, expiresAt: null }
}
