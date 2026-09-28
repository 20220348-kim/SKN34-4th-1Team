import { evaluationSubmissionSchema } from './opsApi'
import type { EvaluationSubmission } from './opsApi'

const key = (owner: string) => `govbiz.ops.pending.v1.${encodeURIComponent(owner)}`

/** 같은 탭의 새로고침·재로그인에 대비한다. 인증정보와 평가 본문은 저장하지 않는다. */
export function readPendingEvaluation(owner: string): EvaluationSubmission | null {
  const raw = sessionStorage.getItem(key(owner))
  if (raw === null) return null
  // 손상/저장소 오류를 새 유료 요청으로 우회하지 않는다.
  return evaluationSubmissionSchema.parse(JSON.parse(raw))
}

export function storePendingEvaluation(owner: string, value: EvaluationSubmission) {
  sessionStorage.setItem(key(owner), JSON.stringify(evaluationSubmissionSchema.parse(value)))
}

export function clearPendingEvaluation(owner: string, requestId: string) {
  const pending = readPendingEvaluation(owner)
  if (pending?.request_id === requestId) sessionStorage.removeItem(key(owner))
}
