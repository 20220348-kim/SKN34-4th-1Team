import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppContainer } from '../../../app/di/container'
import { emptyConversationContext, seoulConversationContext } from '../../fixtures/supportProgramConversation'
import { completeSearchResult } from '../../fixtures/supportProgramSearchResult'
import { supportPrograms } from '../../fixtures/supportPrograms'
import { restoredSupportProgramSearchResponseDtoSchema, supportProgramSearchResponseDtoSchema } from '../../models/SupportProgramDto'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import { SupportProgramSearchRestoreError } from '../../../domain/errors/SupportProgramSearchRestoreError'

const resultToken = '4595df20-ea11-4b17-a37e-c82e1b5c9142'
const expiresAt = '2026-09-10T12:30:00Z'
const limited = { query: '사업화 지원', programs: supportPrograms.slice(0, 2), totalCount: 5, resultToken, expiresAt }
const restored = { ...completeSearchResult({ query: '사업화 지원', programs: supportPrograms.slice(0, 5) }), context: seoulConversationContext }

afterEach(() => vi.unstubAllGlobals())

describe('검색 공개 범위와 저장 결과 복원 계약', () => {
  it('익명 2건과 추가 결과 메타데이터를 Repository·UseCase에서 잃지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(limited))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createAppContainer().resolve('searchSupportProgramsUseCase').execute({ query: limited.query })
    expect(result).toEqual(limited)
    expect(result.programs).toHaveLength(2)
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
  })

  it.each([
    { totalCount: -1 }, { totalCount: 6 }, { totalCount: 3.5 }, { totalCount: 2 },
    { programs: supportPrograms.slice(0, 1) }, { programs: supportPrograms.slice(0, 3) },
    { resultToken: null }, { expiresAt: null }, { resultToken: 'not-a-token' },
    { expiresAt: 'tomorrow' }, { resultToken: resultToken.toUpperCase() },
    { resultToken: null, expiresAt: null }, { totalCount: undefined },
  ])('공개 건수·총 추천 수·토큰·보관시각이 모순되면 거부한다 (%#)', (changes) => {
    expect(supportProgramSearchResponseDtoSchema.safeParse({ ...limited, ...changes }).success).toBe(false)
  })

  it.each([0, 1, 2, 5])('추가 제한이 없는 %s건은 토큰 없이 전체 수와 공개 수가 같다', (count) => {
    const result = completeSearchResult({ query: '지원금', programs: supportPrograms.slice(0, count) })
    expect(result.programs).toHaveLength(count)
    expect(supportProgramSearchResponseDtoSchema.parse(result)).toEqual(result)
  })

  it('전체 저장 결과와 확정 조건을 인증 쿠키로 복원하고 검색을 다시 실행하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(restored))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const result = await createAppContainer().resolve('restoreSupportProgramSearchUseCase').execute(resultToken, controller.signal)
    expect(result).toEqual(restored)
    expect(result.programs).not.toBe(restored.programs)
    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/support-programs/search/results')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal })
    expect(JSON.parse(init.body)).toEqual({ resultToken })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('복원은 전체 공개·동일 조건만 허용하고 빈 최신 목록의 null 검색 의도도 허용한다', () => {
    expect(restoredSupportProgramSearchResponseDtoSchema.safeParse({ ...restored, context: emptyConversationContext }).success).toBe(false)
    expect(restoredSupportProgramSearchResponseDtoSchema.safeParse({ ...limited, context: seoulConversationContext }).success).toBe(false)
    expect(restoredSupportProgramSearchResponseDtoSchema.safeParse({ ...restored, query: '', context: emptyConversationContext }).success).toBe(true)
  })

  it.each([[401, 'unauthorized'], [410, 'expired'], [500, 'unavailable'], [503, 'unavailable']] as const)('%s 복원 실패는 안전한 %s 오류로 알리고 재검색하지 않는다', async (status, reason) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private server detail', { status }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await new SupportProgramRepositoryImpl().restoreSearch(resultToken).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SupportProgramSearchRestoreError)
    expect(error).toMatchObject({ reason })
    expect(String(error)).not.toContain('private server detail')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('잘못된 토큰은 요청하지 않으며 취소된 복원을 재검색이나 안내 성공으로 바꾸지 않는다', async () => {
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const repository = new SupportProgramRepositoryImpl()
    await expect(repository.restoreSearch('invalid')).rejects.toMatchObject({ reason: 'expired' })
    expect(fetchMock).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = repository.restoreSearch(resultToken, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
