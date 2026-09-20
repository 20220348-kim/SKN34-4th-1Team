import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupportProgramClient } from './supportProgramClient'
import type { SupportProgramCatalogFilters } from '../../domain/entities/SupportProgramCatalog'

const filters: SupportProgramCatalogFilters = {
  keyword: '수출 & AI', region: '', category: '', sourceCode: '', startupStage: '',
  applicantType: '', founderAge: '', status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
}
const emptyCatalog = {
  programs: [], total: 0, page: 1, pageSize: 12, totalPages: 0,
  regions: [], categories: [], startupStages: [], applicantTypes: [], founderAges: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('플랫폼별 공고 클라이언트', () => {
  it('웹과 앱의 주소·fetch가 섞이지 않고 한글 검색 조건과 취소 신호를 전달한다', async () => {
    const webFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(emptyCatalog))
    const mobileFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(emptyCatalog))
    const web = createSupportProgramClient({ baseUrl: '/', credentials: 'include', fetch: webFetch })
    const mobile = createSupportProgramClient({ baseUrl: 'https://api.example.test/', fetch: mobileFetch })
    const signal = new AbortController().signal

    await Promise.all([web.browseCatalog(filters), mobile.browseCatalog(filters, signal)])

    expect(String(webFetch.mock.calls[0][0])).toMatch(/^\/api\/v1\/support-programs\/catalog\?/)
    const url = new URL(String(mobileFetch.mock.calls[0][0]))
    expect(url.origin).toBe('https://api.example.test')
    expect(url.searchParams.get('keyword')).toBe('수출 & AI')
    expect(mobileFetch.mock.calls[0][1]?.signal).toBe(signal)
    expect(webFetch).toHaveBeenCalledTimes(1)
    expect(mobileFetch).toHaveBeenCalledTimes(1)
  })

  it('클라이언트 생성 이후 설정된 주소와 전역 fetch를 읽는다', async () => {
    let baseUrl = 'https://old.example.test'
    const client = createSupportProgramClient({ baseUrl: () => baseUrl })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    baseUrl = 'https://current.example.test/'
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.getDetail({ sourceCode: 'BIZINFO', sourceProgramId: 'same-id' })).resolves.toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/current.example.test\/api\//)
  })

  it('네트워크 장애를 다른 검색 경로로 바꾸지 않고 호출자에게 전달한다', async () => {
    const failure = new TypeError('network unavailable')
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure)
    const client = createSupportProgramClient({ baseUrl: 'https://api.example.test', fetch: fetchMock })
    await expect(client.browseCatalog(filters)).rejects.toBe(failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('세션 복원 시 플랫폼별 쿠키 정책을 유지한다', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 410 }))
    const web = createSupportProgramClient({ baseUrl: '/', credentials: 'include', fetch: fetchMock })
    const mobile = createSupportProgramClient({ baseUrl: 'https://api.example.test', fetch: fetchMock })
    await expect(web.restoreSearch('00000000-0000-4000-8000-000000000001')).rejects.toThrow()
    await expect(mobile.restoreSearch('00000000-0000-4000-8000-000000000001')).rejects.toThrow()
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe('omit')
  })
})
