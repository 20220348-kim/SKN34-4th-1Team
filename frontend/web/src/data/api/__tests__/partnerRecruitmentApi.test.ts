import { afterEach, describe, expect, it, vi } from 'vitest'

import { partnerRecruitmentDetail, partnerRecruitmentSummaries } from '../../fixtures/partnerRecruitments'
import { PartnerRecruitmentRepositoryImpl } from '../../repositories/PartnerRecruitmentRepositoryImpl'
import {
  browsePartnerRecruitmentsApi,
  closePartnerRecruitmentApi,
  createPartnerRecruitmentApi,
  getPartnerRecruitmentApi,
  updatePartnerRecruitmentApi,
} from '../partnerRecruitmentApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

const listResponse = { recruitments: partnerRecruitmentSummaries, total: 4, page: 1, pageSize: 20, totalPages: 1 }
const input = {
  sourceCode: 'BIZINFO',
  sourceProgramId: 'PBLN-1',
  title: 'AI 실증 참여기관 구합니다',
  body: '라벨링 운영을 맡아 주실 참여기관을 찾습니다.',
  ownRole: 'LEAD' as const,
  seekingRole: 'PARTICIPANT' as const,
  seekingCount: 1,
  region: '서울',
  minimumCompanyAgeYears: 3,
  capabilities: ['데이터 구축'],
  recruitmentDeadline: '2026-09-20',
}

describe('partnerRecruitmentApi', () => {
  it('sends the list query as parameters with cookies and validates the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listResponse))
    vi.stubGlobal('fetch', fetchMock)

    const list = await browsePartnerRecruitmentsApi({ keyword: '스마트', seekingRoles: ['LEAD'], regions: ['서울', '부산'], mineOnly: true, sourceCode: '', sort: 'RECENT', page: 1 })
    expect(list.recruitments).toHaveLength(4)

    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const url = new URL(requestUrl)
    expect(url.pathname).toBe('/api/v1/partners/recruitments')
    // 역할·지역은 같은 이름을 여러 번 보냅니다.
    expect(url.searchParams.getAll('seekingRole')).toEqual(['LEAD'])
    expect(url.searchParams.getAll('region')).toEqual(['서울', '부산'])
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keyword: '스마트', seekingRole: 'LEAD', region: '부산', mine: 'true', sort: 'RECENT', page: '1', pageSize: '20',
    })
    expect(init.credentials).toBe('include')

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...listResponse, page: 2 }))
    await expect(browsePartnerRecruitmentsApi({ keyword: '', seekingRoles: [], regions: [], mineOnly: false, sourceCode: '', sort: 'DEADLINE', page: 1 }))
      .rejects.toThrow('요청한 페이지와 응답이 다릅니다.')
    const [secondUrl] = fetchMock.mock.calls[1] as [string]
    expect(new URL(secondUrl).searchParams.has('seekingRole')).toBe(false)
    expect(new URL(secondUrl).searchParams.has('region')).toBe(false)
  })

  it('reads a detail, posts a creation, and rejects responses without the contract fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(partnerRecruitmentDetail))
      .mockResolvedValueOnce(jsonResponse(partnerRecruitmentDetail, 201))
      .mockResolvedValueOnce(jsonResponse({ ...partnerRecruitmentDetail, body: undefined }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getPartnerRecruitmentApi(101)).resolves.toMatchObject({ id: 101, ownRole: 'LEAD' })
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/api/v1/partners/recruitments/101')

    await expect(createPartnerRecruitmentApi(input)).resolves.toMatchObject({ id: 101 })
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(input)

    await expect(getPartnerRecruitmentApi(101)).rejects.toThrow()
  })

  it('puts an update and posts a close on the owner endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...partnerRecruitmentDetail, title: '수정한 제목' }))
      .mockResolvedValueOnce(jsonResponse({ ...partnerRecruitmentDetail, status: 'CLOSED' }))
    vi.stubGlobal('fetch', fetchMock)
    const { sourceCode: _sourceCode, sourceProgramId: _sourceProgramId, ...content } = input

    await expect(updatePartnerRecruitmentApi(101, content)).resolves.toMatchObject({ title: '수정한 제목' })
    const [updateUrl, updateInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(updateUrl).pathname).toBe('/api/v1/partners/recruitments/101')
    expect(updateInit.method).toBe('PUT')
    expect(JSON.parse(updateInit.body as string)).toEqual(content)

    await expect(closePartnerRecruitmentApi(101)).resolves.toMatchObject({ status: 'CLOSED' })
    const [closeUrl, closeInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(new URL(closeUrl).pathname).toBe('/api/v1/partners/recruitments/101/close')
    expect(closeInit.method).toBe('POST')
    expect(closeInit.credentials).toBe('include')
  })

  it('maps owner problems of update and close to outcomes', async () => {
    const repository = new PartnerRecruitmentRepositoryImpl()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(problemResponse(403, 'RECRUITMENT_ACTION_FORBIDDEN'))
      .mockResolvedValueOnce(problemResponse(422, 'RECRUITMENT_CLOSED'))
      .mockResolvedValueOnce(problemResponse(422, 'RECRUITMENT_DEADLINE_NOT_ALLOWED', { latestAllowedDeadline: '2026-09-29' }))
      .mockResolvedValueOnce(problemResponse(404, 'RECRUITMENT_NOT_FOUND'))
      .mockResolvedValueOnce(problemResponse(422, 'RECRUITMENT_CLOSED'))
      .mockResolvedValueOnce(problemResponse(403, 'RECRUITMENT_ACTION_FORBIDDEN'))
      .mockResolvedValueOnce(problemResponse(500, null))
    vi.stubGlobal('fetch', fetchMock)
    const { sourceCode: _sourceCode, sourceProgramId: _sourceProgramId, ...content } = input

    await expect(repository.update(101, content)).resolves.toEqual({ outcome: 'forbidden' })
    await expect(repository.update(101, content)).resolves.toEqual({ outcome: 'closed' })
    await expect(repository.update(101, content)).resolves.toEqual({ outcome: 'deadline-not-allowed', latestAllowedDeadline: '2026-09-29' })
    await expect(repository.update(101, content)).resolves.toEqual({ outcome: 'not-found' })
    await expect(repository.close(101)).resolves.toEqual({ outcome: 'already-closed' })
    await expect(repository.close(101)).resolves.toEqual({ outcome: 'forbidden' })
    await expect(repository.close(101)).rejects.toMatchObject({ status: 500 })
  })

  it('maps not-found to null and business problems to outcomes, rethrowing the rest', async () => {
    const repository = new PartnerRecruitmentRepositoryImpl()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(problemResponse(404, 'RECRUITMENT_NOT_FOUND'))
      .mockResolvedValueOnce(problemResponse(403, 'COMPANY_REQUIRED'))
      .mockResolvedValueOnce(problemResponse(404, 'RECRUITMENT_PROGRAM_NOT_FOUND'))
      .mockResolvedValueOnce(problemResponse(422, 'RECRUITMENT_PROGRAM_CLOSED'))
      .mockResolvedValueOnce(problemResponse(422, 'RECRUITMENT_DEADLINE_NOT_ALLOWED', { latestAllowedDeadline: '2026-09-29' }))
      .mockResolvedValueOnce(problemResponse(409, 'RECRUITMENT_ALREADY_EXISTS'))
      .mockResolvedValueOnce(problemResponse(401, 'AUTHENTICATION_REQUIRED'))
      .mockResolvedValueOnce(problemResponse(500, null))
    vi.stubGlobal('fetch', fetchMock)

    await expect(repository.getDetail(999)).resolves.toBeNull()
    await expect(repository.create(input)).resolves.toEqual({ outcome: 'company-required' })
    await expect(repository.create(input)).resolves.toEqual({ outcome: 'program-not-found' })
    await expect(repository.create(input)).resolves.toEqual({ outcome: 'program-closed' })
    await expect(repository.create(input)).resolves.toEqual({ outcome: 'deadline-not-allowed', latestAllowedDeadline: '2026-09-29' })
    await expect(repository.create(input)).resolves.toEqual({ outcome: 'already-exists' })
    await expect(repository.create(input)).rejects.toMatchObject({ status: 401 })
    await expect(repository.getDetail(1)).rejects.toMatchObject({ status: 500 })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function problemResponse(status: number, code: string | null, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify(code === null ? {} : { code, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}
