import { partnerRecruitmentDtoSchema, partnerRecruitmentListDtoSchema,
  toPartnerRecruitment, toPartnerRecruitmentPage } from '@govbiz/shared/data/models/PartnerRecruitmentDto'
import { partnerProposalBoxDtoSchema, partnerProposalDtoSchema,
  toPartnerProposal, toPartnerProposalBoxPage } from '@govbiz/shared/data/models/PartnerProposalDto'
import type { PartnerRecruitmentQuery } from '@govbiz/shared/domain/entities/PartnerRecruitmentQuery'
import { partnerRecruitmentPageSize } from '@govbiz/shared/domain/entities/PartnerRecruitmentQuery'
import type { PartnerRecruitmentContentInput, PartnerRecruitmentInput } from '@govbiz/shared/domain/entities/PartnerRecruitment'
import type { CreatePartnerRecruitmentResult, UpdatePartnerRecruitmentResult } from '@govbiz/shared/domain/repositories/PartnerRecruitmentRepository'
import { CreatePartnerRecruitmentUseCase, UpdatePartnerRecruitmentUseCase } from '@govbiz/shared/domain/usecases/PartnerRecruitmentUseCases'
import type { PartnerProposalBox, PartnerProposalInput } from '@govbiz/shared/domain/entities/PartnerProposal'
import type { PartnerProposalAction } from '@govbiz/shared/domain/repositories/PartnerProposalRepository'
import { apiRequest, ApiError, errorMessage } from './client'

const recruitments = '/api/v1/partners/recruitments'
const proposals = '/api/v1/partners/proposals'

export async function browseRecruitments(query: PartnerRecruitmentQuery, token?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ keyword: query.keyword.trim(), mine: String(query.mineOnly),
    sort: query.sort, page: String(query.page), pageSize: String(partnerRecruitmentPageSize) })
  query.seekingRoles.forEach((role) => params.append('seekingRole', role))
  query.regions.forEach((region) => params.append('region', region))
  if (query.sourceCode) params.set('sourceCode', query.sourceCode)
  const result = toPartnerRecruitmentPage(partnerRecruitmentListDtoSchema.parse(
    await apiRequest(`${recruitments}?${params}`, { accessToken: token, signal }),
  ))
  if (result.page !== query.page) throw new Error('모집글 페이지 응답이 요청과 다릅니다.')
  return result
}

export async function getRecruitment(id: number, token?: string, signal?: AbortSignal) {
  return toPartnerRecruitment(partnerRecruitmentDtoSchema.parse(
    await apiRequest(`${recruitments}/${id}`, { accessToken: token, signal }),
  ))
}

/** Shared input rules run before the Bearer request; DTO mapping and API failures stay at this boundary. */
export function createRecruitment(input: PartnerRecruitmentInput, token: string, signal?: AbortSignal) {
  const useCase = new CreatePartnerRecruitmentUseCase({
    async create(value, requestSignal): Promise<CreatePartnerRecruitmentResult> {
      try {
        const recruitment = toPartnerRecruitment(partnerRecruitmentDtoSchema.parse(
          await apiRequest(recruitments, { method: 'POST', body: value, accessToken: token, signal: requestSignal }),
        ))
        if (recruitment.program.sourceCode !== value.sourceCode || recruitment.program.sourceProgramId !== value.sourceProgramId
          || !recruitment.isMine) throw new Error('작성한 모집글과 응답이 다릅니다.')
        return { outcome: 'created', recruitment }
      } catch (cause) {
        if (cause instanceof ApiError) {
          if (cause.code === 'COMPANY_REQUIRED' || cause.code === 'ACTIVE_BUSINESS_REQUIRED') return { outcome: 'company-required' }
          if (cause.code === 'RECRUITMENT_PROGRAM_NOT_FOUND') return { outcome: 'program-not-found' }
          if (cause.code === 'RECRUITMENT_PROGRAM_CLOSED') return { outcome: 'program-closed' }
          if (cause.code === 'RECRUITMENT_DEADLINE_NOT_ALLOWED') return { outcome: 'deadline-not-allowed', latestAllowedDeadline: null }
          if (cause.code === 'RECRUITMENT_ALREADY_EXISTS') return { outcome: 'already-exists' }
        }
        throw cause
      }
    },
  })
  return useCase.execute(input, signal)
}

/** 수정 입력에는 연결 공고를 넣지 않는다. 기존 shared 규칙과 DTO 변환을 앱의 Bearer 요청에서 사용한다. */
export function updateRecruitment(id: number, input: PartnerRecruitmentContentInput, token: string, signal?: AbortSignal) {
  return new UpdatePartnerRecruitmentUseCase({
    async update(recruitmentId, value, requestSignal): Promise<UpdatePartnerRecruitmentResult> {
      try {
        const body: PartnerRecruitmentContentInput = { title: value.title, body: value.body, ownRole: value.ownRole,
          seekingRole: value.seekingRole, seekingCount: value.seekingCount, region: value.region,
          minimumCompanyAgeYears: value.minimumCompanyAgeYears, capabilities: value.capabilities, recruitmentDeadline: value.recruitmentDeadline }
        const recruitment = toPartnerRecruitment(partnerRecruitmentDtoSchema.parse(
          await apiRequest(`${recruitments}/${recruitmentId}`, { method: 'PUT', body, accessToken: token, signal: requestSignal }),
        ))
        if (recruitment.id !== recruitmentId || !recruitment.isMine) throw new Error('수정한 모집글과 응답이 다릅니다.')
        return { outcome: 'updated', recruitment }
      } catch (cause) {
        if (cause instanceof ApiError) {
          if (cause.code === 'RECRUITMENT_NOT_FOUND') return { outcome: 'not-found' }
          if (cause.code === 'RECRUITMENT_ACTION_FORBIDDEN') return { outcome: 'forbidden' }
          if (cause.code === 'RECRUITMENT_CLOSED') return { outcome: 'closed' }
          if (cause.code === 'RECRUITMENT_DEADLINE_NOT_ALLOWED') return { outcome: 'deadline-not-allowed', latestAllowedDeadline: null }
        }
        throw cause
      }
    },
  }).execute(id, input, signal)
}

export async function closeRecruitment(id: number, token: string, signal?: AbortSignal) {
  return toPartnerRecruitment(partnerRecruitmentDtoSchema.parse(
    await apiRequest(`${recruitments}/${id}/close`, { method: 'POST', accessToken: token, signal }),
  ))
}

export async function sendProposal(recruitmentId: number, input: PartnerProposalInput, token: string, signal?: AbortSignal) {
  const proposal = toPartnerProposal(partnerProposalDtoSchema.parse(
    await apiRequest(`${recruitments}/${recruitmentId}/proposals`, { method: 'POST', body: input, accessToken: token, signal }),
  ))
  if (proposal.recruitment.id !== recruitmentId) throw new Error('제안한 모집글과 응답이 다릅니다.')
  return proposal
}

export async function browseProposals(box: PartnerProposalBox, token: string, signal?: AbortSignal) {
  const page = toPartnerProposalBoxPage(partnerProposalBoxDtoSchema.parse(
    await apiRequest(`/api/v1/me/proposals?${new URLSearchParams({ box })}`, { accessToken: token, signal }),
  ))
  if (page.box !== box) throw new Error('요청한 제안함과 응답이 다릅니다.')
  return page
}

export async function getProposal(id: number, token: string, signal?: AbortSignal) {
  return toPartnerProposal(partnerProposalDtoSchema.parse(
    await apiRequest(`${proposals}/${id}`, { accessToken: token, signal }),
  ))
}

export async function respondProposal(id: number, action: PartnerProposalAction, token: string, signal?: AbortSignal) {
  return toPartnerProposal(partnerProposalDtoSchema.parse(
    await apiRequest(`${proposals}/${id}/${action}`, { method: 'POST', accessToken: token, signal }),
  ))
}

export function getPartnerWebUrl(path: '/app/partners/new' | '/app/partners/edit' | '/partners/detail', id?: number) {
  const configured = process.env.EXPO_PUBLIC_WEB_BASE_URL?.trim()
  if (!configured) throw new Error('웹 주소가 설정되지 않았습니다. 앱의 공개 웹 주소 설정을 확인해 주세요.')
  let url: URL
  try { url = new URL(configured) } catch { throw new Error('웹 주소 설정을 확인해 주세요.') }
  const localHost = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(__DEV__ && url.protocol === 'http:' && localHost))) {
    throw new Error('웹 주소는 HTTPS origin이어야 합니다. 개발 중에는 로컬 HTTP 주소를 사용할 수 있습니다.')
  }
  const target = new URL(path, url.origin)
  if (id !== undefined) target.searchParams.set('recruitmentId', String(id))
  return target.href
}

export function partnerErrorMessage(cause: unknown) {
  if (cause instanceof Error && cause.message.startsWith('웹 주소')) return cause.message
  if (cause instanceof ApiError) {
    if (cause.code === 'COMPANY_REQUIRED' || cause.code === 'ACTIVE_BUSINESS_REQUIRED') return '제안·모집글 작성과 수정은 등록된 계속사업자만 할 수 있습니다.'
    if (cause.code === 'PROPOSAL_ALREADY_SENT') return '이 모집글에는 이미 제안을 보냈습니다.'
    if (cause.code === 'RECRUITMENT_CLOSED') return '모집이 마감되었습니다. 목록을 새로고침해 주세요.'
    if (cause.code === 'RECRUITMENT_NOT_FOUND') return '모집글을 찾을 수 없습니다.'
    if (cause.code === 'PROPOSAL_NOT_PENDING') return '이미 처리되었거나 응답 기한이 지난 제안입니다.'
    if (cause.code === 'PROPOSAL_OWN_RECRUITMENT') return '내 모집글에는 제안할 수 없습니다.'
    if (cause.code === 'PROPOSAL_ACTION_FORBIDDEN') return '이 제안을 처리할 권한이 없습니다.'
  }
  return errorMessage(cause)
}
