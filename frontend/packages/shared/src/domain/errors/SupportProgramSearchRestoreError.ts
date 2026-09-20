/** 저장한 검색 결과 복원 실패만 구분하며 서버의 원문 오류를 보관하지 않습니다. */
export class SupportProgramSearchRestoreError extends Error {
  readonly reason: 'unauthorized' | 'expired' | 'unavailable'

  constructor(reason: 'unauthorized' | 'expired' | 'unavailable') {
    super(reason === 'unauthorized' ? '로그인 후 검색 결과를 확인해 주세요.'
      : reason === 'expired' ? '검색 결과 보관 시간이 지났거나 확인할 수 없는 결과입니다. 새로 검색해 주세요.'
        : '검색 결과를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    this.name = 'SupportProgramSearchRestoreError'
    this.reason = reason
  }
}
