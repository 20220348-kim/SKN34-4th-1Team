import { afterEach, describe, expect, it, vi } from 'vitest'

import { supportPrograms } from '../../fixtures/supportPrograms'
import { SavedSupportProgramRepositoryImpl } from '../../repositories/SavedSupportProgramRepositoryImpl'
import { AccountApiError } from '../accountApi'
import {
  getSavedSupportProgramStatusApi,
  listSavedSupportProgramsApi,
  removeSavedSupportProgramApi,
  saveSupportProgramApi,
} from '../savedSupportProgramApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

const identity = { sourceCode: 'BIZINFO', sourceProgramId: 'PBLN 1/2' }
const savedDto = { savedAt: '2026-09-12T10:00:00', program: { ...supportPrograms[0]! } }

describe('savedSupportProgramApi', () => {
  it('관심 공고가 0개인 정상 응답은 빈 목록으로 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ programs: [] })))

    await expect(listSavedSupportProgramsApi()).resolves.toEqual([])
  })

  it('관심 API 자체가 없는 404를 관심 공고 0개로 처리하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(404, null)))

    await expect(listSavedSupportProgramsApi()).rejects.toMatchObject({ status: 404 })
  })

  it('reads the list and status with the session cookie and no cache', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ programs: [savedDto] }))
      .mockResolvedValueOnce(jsonResponse({ saved: true }))
    vi.stubGlobal('fetch', fetchMock)

    const list = await listSavedSupportProgramsApi()
    expect(list).toHaveLength(1)
    expect(list[0]!.program.id).toBe(supportPrograms[0]!.id)
    await expect(getSavedSupportProgramStatusApi(identity)).resolves.toBe(true)

    const [listUrl, listInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(listUrl).toMatch(/\/api\/v1\/me\/saved-programs$/)
    expect(listInit.credentials).toBe('include')
    expect(listInit.cache).toBe('no-store')
    const [statusUrl] = fetchMock.mock.calls[1] as [string]
    const statusParams = new URL(statusUrl).searchParams
    expect(statusParams.get('sourceCode')).toBe('BIZINFO')
    expect(statusParams.get('sourceProgramId')).toBe('PBLN 1/2')
  })

  it('saves with a JSON body and removes with query parameters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(savedDto))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveSupportProgramApi(identity)).resolves.toEqual(expect.objectContaining({ savedAt: '2026-09-12T10:00:00' }))
    await expect(removeSavedSupportProgramApi(identity)).resolves.toBeUndefined()

    const [, saveInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(saveInit.method).toBe('POST')
    expect(JSON.parse(String(saveInit.body))).toEqual(identity)
    const [removeUrl, removeInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(removeInit.method).toBe('DELETE')
    expect(new URL(removeUrl).searchParams.get('sourceProgramId')).toBe('PBLN 1/2')
  })

  it('throws the account api error with the problem code for failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problemResponse(401, 'AUTHENTICATION_REQUIRED')))

    await expect(listSavedSupportProgramsApi()).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' })
    await expect(listSavedSupportProgramsApi()).rejects.toBeInstanceOf(AccountApiError)
  })
})

describe('SavedSupportProgramRepositoryImpl', () => {
  it('maps a missing program to not-found and passes other failures through', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(savedDto))
      .mockResolvedValueOnce(problemResponse(404, 'SUPPORT_PROGRAM_NOT_FOUND'))
      .mockResolvedValueOnce(problemResponse(500, null)))
    const repository = new SavedSupportProgramRepositoryImpl()

    await expect(repository.save(identity)).resolves.toEqual({
      outcome: 'saved',
      saved: { savedAt: '2026-09-12T10:00:00', program: expect.objectContaining({ id: supportPrograms[0]!.id }) },
    })
    await expect(repository.save(identity)).resolves.toEqual({ outcome: 'not-found' })
    await expect(repository.save(identity)).rejects.toBeInstanceOf(AccountApiError)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function problemResponse(status: number, code: string | null): Response {
  return new Response(JSON.stringify(code === null ? {} : { code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}
