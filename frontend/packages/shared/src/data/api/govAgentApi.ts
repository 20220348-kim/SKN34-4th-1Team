import type { GovAgentRequest, GovAgentResult } from '../../domain/entities/GovAgent'
import { parseGovAgentResult } from '../models/GovAgentDto'
import { readPlanQuotaProblem } from '../models/PlanUsageDto'
import type { SupportProgramHttpContext } from './supportProgramClient'

/** 사용자에게 보여 줄 고정 오류만 반환하고 upstream 본문은 노출하지 않습니다. */
export class GovAgentApiError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export async function sendGovAgentMessageApi(context: SupportProgramHttpContext, command: GovAgentRequest, signal?: AbortSignal): Promise<GovAgentResult> {
  const response = await context.fetch(`${context.baseUrl}/api/v1/gov-agent/messages`, {
    method: 'POST', credentials: context.credentials, signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  })
  if (!response.ok) {
    const quota = readPlanQuotaProblem(response.status, await response.json().catch(() => null))
    if (quota) throw quota
    throw new GovAgentApiError(response.status === 401 || response.status === 403
      ? 'Gov 에이전트는 로그인한 관리자만 이용할 수 있습니다.'
      : response.status === 429 ? '요청이 많습니다. 잠시 기다린 뒤 다시 요청해 주세요.'
        : response.status === 504 ? 'Gov 에이전트 응답 시간이 초과되었습니다. 다시 요청해 주세요.'
        : response.status === 422 ? '이 공고의 원문 질문은 현재 지원하지 않습니다. 공식 원문을 확인해 주세요.'
          : 'Gov 에이전트 요청을 처리하지 못했습니다. 잠시 후 다시 요청해 주세요.', response.status)
  }
  return parseGovAgentResult(await response.json(), command.selectedProgram)
}
