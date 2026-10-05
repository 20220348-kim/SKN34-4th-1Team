/**
 * 감사 기록(관리자 접속기록)의 수행 업무입니다. 서버의 DB CHECK 값과 같습니다.
 * 회원 목록·상세 조회, 계정 조치, 감사 기록 조회가 요청 하나에 한 건씩 남습니다.
 */
export type AdminAuditAction =
  | 'ACCOUNT_LIST'
  | 'ACCOUNT_DETAIL'
  | 'ACCOUNT_SUSPEND'
  | 'ACCOUNT_UNSUSPEND'
  | 'ACCOUNT_SESSIONS_REVOKE'
  | 'ACCOUNT_ADMIN_GRANT'
  | 'ACCOUNT_ADMIN_REVOKE'
  | 'AUDIT_LOG_LIST'

export const adminAuditActionLabels: Record<AdminAuditAction, string> = {
  ACCOUNT_LIST: '회원 목록 조회',
  ACCOUNT_DETAIL: '회원 상세 조회',
  ACCOUNT_SUSPEND: '계정 정지',
  ACCOUNT_UNSUSPEND: '정지 해제',
  ACCOUNT_SESSIONS_REVOKE: '강제 로그아웃',
  ACCOUNT_ADMIN_GRANT: '관리자 권한 부여',
  ACCOUNT_ADMIN_REVOKE: '관리자 권한 해제',
  AUDIT_LOG_LIST: '감사 기록 조회',
}

export const adminAuditActions = Object.keys(adminAuditActionLabels) as AdminAuditAction[]

/**
 * 감사 기록 한 건입니다. 처리자는 계정 ID와 지금의 이메일(계정 행이 없으면 null), 대상은 계정 ID만 있습니다.
 * 요청 요약은 검색어 원문 같은 개인정보 없이 조건 이름·건수·조치 기록 번호만 담습니다. 시각은 서울 기준 ISO 로컬 시각입니다.
 */
export type AdminAuditLogRecord = {
  id: number
  action: AdminAuditAction
  actorAccountId: number
  actorEmail: string | null
  targetAccountId: number | null
  requestSummary: string | null
  clientIp: string
  userAgent: string | null
  createdAt: string
}

/** 감사 기록 조건입니다. null·빈 문자열이면 전체이고, 기간은 서울 기준 날짜(`yyyy-MM-dd`)로 끝 날을 포함합니다. */
export type AdminAuditLogQuery = {
  actorAccountId: number | null
  targetAccountId: number | null
  action: AdminAuditAction | ''
  from: string
  to: string
}

export const defaultAdminAuditLogQuery: AdminAuditLogQuery = {
  actorAccountId: null,
  targetAccountId: null,
  action: '',
  from: '',
  to: '',
}

/** 한 번에 읽는 최대 건수입니다. 서버 한도와 같습니다. */
export const adminAuditLogPageSize = 50

/** 최신순 한 쪽입니다. `nextCursor`가 있으면 그 ID보다 오래된 기록을 이어서 읽습니다. */
export type AdminAuditLogPage = {
  records: AdminAuditLogRecord[]
  nextCursor: number | null
}

/** 조건을 서버에 보내기 전에 확인할 수 있는 문제입니다. */
export type AdminAuditLogQueryIssue = 'invalid-account-id' | 'invalid-date' | 'reversed-period'

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

/** 달력에 있는 `yyyy-MM-dd` 날짜인지 봅니다. */
export function isAdminAuditDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** 조건의 문제를 찾습니다. 문제가 없으면 null입니다. 날짜가 모두 있으면 시작일이 종료일보다 늦을 수 없습니다. */
export function adminAuditLogQueryIssue(query: AdminAuditLogQuery): AdminAuditLogQueryIssue | null {
  const ids = [query.actorAccountId, query.targetAccountId]
  if (ids.some((id) => id !== null && (!Number.isSafeInteger(id) || id < 1))) return 'invalid-account-id'
  if ([query.from, query.to].some((date) => date !== '' && !isAdminAuditDate(date))) return 'invalid-date'
  if (query.from !== '' && query.to !== '' && query.from > query.to) return 'reversed-period'
  return null
}
