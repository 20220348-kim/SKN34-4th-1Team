export class ApplicationPreparationError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(messageFor(code, status))
    this.name = 'ApplicationPreparationError'
    this.status = status
    this.code = code
  }
}

function messageFor(code: string, status: number): string {
  if (code === 'APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED') return '여러 입력칸이 한 질문으로 묶인 이전 양식입니다. 기존 답변을 보관한 채 입력칸별로 다시 분석해 새 작성을 시작해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_UNMAPPED_INPUT') return '입력한 답변 중 자동 기입할 수 없는 항목이 있습니다. 해당 항목은 원본에서 직접 작성해야 합니다.'
  if (code === 'APPLICATION_DOCUMENT_NO_WRITABLE_INPUT') return '자동 기입할 수 있는 답변이 없어 초안을 생성하지 않았습니다. 저장된 답변을 확인하며 원본 문서에서 직접 작성해 주세요.'
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.'
  if (code === 'RUN_OUTCOME_UNKNOWN') return '분석 결과를 확정할 수 없어 자동 재실행을 중단했습니다. 관리자 확인이 필요합니다.'
  if (code === 'QUEUE_EXPIRED') return '분석 대기 시간이 초과되었습니다. 공고를 다시 선택해 새 작업을 요청할 수 있습니다.'
  if (code === 'ACCOUNT_INACTIVE') return '계정 상태가 변경되어 분석을 중단했습니다.'
  if (code === 'DISCOVERY_FAILED') return '공식 문서 분석을 완료하지 못했습니다. 작업 내역을 확인해 주세요.'
  if (code === 'APPLICATION_FORM_QUEUE_UNAVAILABLE') return '공식 문서 분석 큐가 비활성화되어 있습니다. 관리자에게 문의해 주세요.'
  if (code === 'APPLICATION_FORM_JOB_NOT_FOUND') return '본인의 분석 작업을 찾을 수 없습니다.'
  if (code === 'APPLICATION_FORM_JOB_CONFLICT') return '같은 공고의 이전 분석이 진행 중이거나 결과 확인이 필요해 새 분석을 시작할 수 없습니다. 잠시 후에도 계속 표시되면 관리자에게 문의해 주세요.'
  if (code === 'APPLICATION_FORM_JOB_CAPACITY') return '진행 중이거나 확인이 필요한 분석이 3건입니다. 기존 작업을 먼저 확인해 주세요.'
  if (code === 'APPLICATION_PREPARATION_API_UNAVAILABLE') return '현재 연결된 서버가 신청 문서 작성 기능을 지원하지 않습니다. Core·AI Service 이미지를 갱신한 뒤 다시 시도해 주세요.'
  if (code === 'APPLICATION_PREPARATION_NOT_FOUND') return '신청 준비 건을 찾을 수 없습니다.'
  if (code === 'APPLICATION_FORM_NOT_SUPPORTED') return '현재 지원하지 않는 공고·양식·지원 분야입니다.'
  if (code === 'APPLICATION_FORM_NO_FORM') return '현재 지원하지 않는 신청 문서 형식입니다. 공식 공고 원문에서 신청 방법을 확인해 주세요.'
  if (code === 'APPLICATION_FORM_SOURCE_UNSUPPORTED') return '공식 PDF/HWP/HWPX 첨부를 확보하고 읽을 수 있는 공고만 분석할 수 있습니다.'
  if (code === 'APPLICATION_FORM_SOURCE_NOT_FOUND') return '공식 공고나 첨부를 찾지 못했습니다. 공고 ID를 확인해 주세요.'
  if (code === 'APPLICATION_FORM_SOURCE_TOO_LARGE') return '공식 첨부가 자동 분석 가능한 크기나 페이지 수를 초과했습니다.'
  if (code === 'APPLICATION_FORM_SOURCE_INVALID') return '공식 첨부의 형식이나 출처를 안전하게 확인하지 못했습니다.'
  if (code === 'APPLICATION_FORM_SOURCE_UNAVAILABLE') return '공식 공고나 첨부를 지금 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.'
  if (code === 'APPLICATION_FORM_AI_INVALID_RESPONSE') return 'AI가 공식 첨부의 문항 근거를 확인하지 못해 분석을 종료했습니다. 공고를 다시 선택하면 새 분석을 요청할 수 있습니다.'
  if (code === 'APPLICATION_PREPARATION_SECTION_NOT_FOUND') return '현재 지원하지 않는 작성 항목입니다.'
  if (code === 'APPLICATION_PREPARATION_REVISION_CONFLICT') return '입력·작성본 또는 진행 단계가 변경되었습니다. 최신 내용을 다시 불러와 확인해 주세요.'
  if (code === 'APPLICATION_PREPARATION_RUN_CONFLICT') return '이전 AI 요청이 진행 중이거나 같은 요청을 다시 사용할 수 없습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.'
  if (code === 'AI_SERVICE_TIMEOUT') return 'AI 처리 시간이 초과되었습니다. 저장된 답변과 작성본을 확인한 뒤 다시 시도해 주세요.'
  if (code === 'AI_SERVICE_UNAVAILABLE' || code === 'AI_SERVICE_INVALID_RESPONSE') return 'AI가 답변을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_INPUT_REQUIRED') return '필수 답변을 모두 저장한 뒤 문서를 생성해 주세요. 모르는 내용은 미정으로 저장할 수 있습니다.'
  if (code === 'APPLICATION_DOCUMENT_SOURCE_CHANGED') return '공식 첨부가 변경되었거나 없어졌습니다. 양식을 다시 찾아 새 작성을 시작해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_MAPPING_FAILED') return '공식 양식의 입력 위치를 확인하지 못해 작업을 중단했습니다. 양식 분석 결과를 확인해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_MCP_NOT_READY') return '문서 생성 서비스를 사용할 수 없습니다. 관리자에게 문의해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_PLAN_TIMEOUT') return '문서 위치·작성 계획 분석 시간이 초과되었습니다. 저장된 답변을 유지한 채 다시 시도할 수 있습니다.'
  if (code === 'APPLICATION_DOCUMENT_PLAN_FAILED') return '문서 위치·작성 계획을 확인하지 못했습니다. 저장된 답변은 유지됩니다.'
  if (code === 'APPLICATION_DOCUMENT_MCP_FAILED') return '문서 편집 도구가 작업을 완료하지 못했습니다. 관리자에게 문의해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_VALIDATION_FAILED') return '작성 결과가 검증을 통과하지 못해 파일을 공개하지 않았습니다.'
  if (code === 'APPLICATION_DOCUMENT_OVERFLOW') return '입력란에 답변 전체가 들어가지 않습니다. 답변을 수정하고 확인한 뒤 다시 생성해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_RUN_CONFLICT') return '문서 편집 서버가 다른 작업을 처리 중입니다. 잠시 후 다시 시도해 주세요.'
  if (code === 'APPLICATION_DOCUMENT_OUTCOME_UNKNOWN') return '문서 작업의 종료 여부를 확인하지 못했습니다. 중복 실행을 피하려면 관리자 확인이 필요합니다.'
  if (code === 'APPLICATION_DOCUMENT_LIMIT_EXCEEDED') return '문서가 크기·페이지·편집 작업 수 제한을 초과했습니다.'
  if (code === 'APPLICATION_DOCUMENT_UNSUPPORTED') return '원본의 구조 또는 편집 제한으로 문서를 생성하지 못했습니다. 원본 파일을 확인해 주세요.'
  if (code === 'REQUEST_VALIDATION_FAILED' || status === 400) return '선택한 공식 양식과 지원 분야를 다시 확인해 주세요.'
  if (code === 'INVALID_RESPONSE') return '신청 준비 응답 형식을 확인하지 못했습니다.'
  if (code === 'REQUEST_TIMEOUT') return '신청 준비 요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
  if (code === 'REQUEST_FAILED' || status === 0) return 'Core API에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.'
  return '신청 준비 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}
