import { CombinationReviewError } from '../../../../domain/errors/CombinationReviewError'

export function reviewFailureMessage(error: unknown): string {
  if (!(error instanceof CombinationReviewError)) return '요청 결과를 확인하지 못했습니다. 조회는 다시 시도할 수 있습니다. 분석 응답이 유실됐다면 같은 요청 확인을 이용하세요.'
  if (error.code === 'COMBINATION_REVIEW_API_UNAVAILABLE') return '현재 연결된 서버에서 검토 API를 찾을 수 없습니다. Core API 실행 버전과 연결 주소를 확인해야 합니다. 입력은 유지됩니다.'
  if (error.code === 'RUN_QUEUE_UNAVAILABLE') return '분석 작업 접수가 비활성화되어 있습니다. 운영자가 RabbitMQ와 분석 큐 설정을 확인해야 합니다. 새 작업은 접수되지 않았습니다.'
  if (error.status === 401) return '로그인 세션이 만료되었습니다. 개인 화면을 닫고 다시 로그인해 주세요.'
  if (error.status === 403) return '계정 상태 또는 요청 권한을 확인해 주세요.'
  if (error.status === 404) return '검토 또는 실행을 찾을 수 없습니다. 본인에게 저장된 항목인지 확인해 주세요.'
  if (error.status === 409) return error.code === 'COMBINATION_REVIEW_REVISION_CONFLICT'
    ? '다른 화면에서 입력이 변경되었습니다. 작성 중인 입력은 유지됩니다. 최신 저장 입력을 조회한 뒤 직접 선택해 주세요.'
    : '실행 요청이 충돌했습니다. 실행 이력을 확인해 주세요. 요청 키나 내용을 자동으로 변경하지 않습니다.'
  if (error.status === 422) return error.code === 'INPUT_PROGRAM_COUNT_UNSUPPORTED'
    ? '새 분석은 공고를 정확히 2개 선택해야 합니다. 기존 결과는 그대로 조회할 수 있습니다.'
    : '현재 지원하지 않는 원문 형식·제공처 또는 문서 크기입니다. 정상적인 근거 부족 판단이 아닌 수집 실패입니다.'
  if (error.status === 429) return `요청량 또는 동시 실행 한도에 도달했습니다.${error.retryAfter ? ` 재확인 대기: ${error.retryAfter}초.` : ''} 실패 실행이 있으면 이력에서 확인해 주세요.`
  if (error.status === 503) return '원문 수집 또는 분석 서비스의 기술 오류입니다. 근거 부족이나 허용 판단을 의미하지 않습니다.'
  return '서버 응답을 안전하게 해석하지 못했습니다. 저장된 실행 이력을 확인해 주세요.'
}

const runFailureMessages: Record<string, string> = {
  INPUT_PROGRAM_COUNT_UNSUPPORTED: '선택한 공고 수가 현재 분석 조건과 맞지 않아 분석해 드릴 수 없습니다. 서로 다른 공고를 정확히 2개 선택해 주세요.',
  SOURCE_UNSUPPORTED: '선택한 공고의 공식 첨부 문서를 자동으로 읽을 수 없어 분석해 드릴 수 없습니다. 첨부 문서가 없거나 이미지·암호화 문서 또는 지원하지 않는 형식일 수 있습니다. 다른 공고를 선택하거나 공식 원문을 직접 확인해 주세요.',
  SOURCE_NOT_FOUND: '선택한 공고의 공식 원문 또는 첨부 문서를 찾을 수 없어 분석해 드릴 수 없습니다. 공고가 삭제되거나 첨부 주소가 변경되었을 수 있으니 공식 공고 페이지를 확인해 주세요.',
  SOURCE_UNAVAILABLE: '공식 공고 제공처에 일시적으로 연결할 수 없어 분석해 드릴 수 없습니다. 잠시 후 다시 시도해 주세요.',
  SOURCE_INVALID: '선택한 공고의 공식 원문 또는 첨부 문서를 정상적으로 확인할 수 없어 분석해 드릴 수 없습니다. 공식 공고 페이지에서 원문을 직접 확인해 주세요.',
  SOURCE_TOO_LARGE: '공식 첨부 문서의 수나 분량이 자동 분석 한도를 초과해 분석해 드릴 수 없습니다. 공식 원문을 직접 확인해 주세요.',
  ANALYSIS_UNAVAILABLE: '분석 서비스에 일시적으로 연결할 수 없어 분석해 드릴 수 없습니다. 잠시 후 다시 시도해 주세요.',
  ANALYSIS_INVALID: '분석 결과를 안전하게 확인할 수 없어 결과를 제공하지 않았습니다. 잠시 후 다시 시도해 주세요.',
  RUN_FAILED: '분석 처리 중 일시적인 시스템 오류가 발생해 분석해 드릴 수 없습니다. 잠시 후 다시 시도해 주세요.',
  RUN_CAPACITY_EXCEEDED: '현재 처리 중인 분석 요청이 많아 실행하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  RUN_RATE_LIMITED: '짧은 시간에 분석 요청이 많이 접수되어 실행하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  RUN_QUEUE_UNAVAILABLE: '현재 분석 요청을 접수할 수 없어 실행하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  QUEUE_EXPIRED: '분석 요청이 대기 시간 안에 처리되지 않아 종료되었습니다. 잠시 후 새 분석을 실행해 주세요.',
  ACCOUNT_INACTIVE: '계정 상태가 변경되어 분석을 진행할 수 없습니다. 로그인 및 계정 상태를 확인해 주세요.',
}

export function reviewRunFailureMessage(failureCode: string | null): string {
  return failureCode
    ? runFailureMessages[failureCode] ?? '분석 처리 중 오류가 발생해 분석해 드릴 수 없습니다. 잠시 후 다시 시도해 주세요.'
    : '분석 처리 중 오류가 발생해 분석해 드릴 수 없습니다. 잠시 후 다시 시도해 주세요.'
}
