import type {
  AdminAccountActionKind,
  AdminAccountDetail,
  AdminAccountPage,
  AdminAccountQuery,
  AdminAccountStats,
} from '../entities/AdminAccount'

/** 조치 실패 사유는 화면이 다르게 안내해야 하므로 예외가 아닌 결과로 구분합니다. */
export type AdminAccountActionResult =
  | { outcome: 'done'; detail: AdminAccountDetail }
  | { outcome: 'not-found' }
  | { outcome: 'self-action' }
  | { outcome: 'protected' }
  | { outcome: 'conflict' }

/** 관리자 계정 관리 기능이 Data Layer의 HTTP 세부사항과 분리되도록 하는 Domain 포트입니다. 관리자 세션이 있어야 합니다. */
export interface AdminAccountRepository {
  getStats(signal?: AbortSignal): Promise<AdminAccountStats>
  browse(query: AdminAccountQuery, signal?: AbortSignal): Promise<AdminAccountPage>
  /** 없거나 삭제된 계정은 null입니다. */
  getDetail(id: number, signal?: AbortSignal): Promise<AdminAccountDetail | null>
  /** 정지·정지 해제·강제 로그아웃입니다. 사유는 조치 기록에 남습니다. */
  act(id: number, kind: AdminAccountActionKind, reason: string, signal?: AbortSignal): Promise<AdminAccountActionResult>
}
