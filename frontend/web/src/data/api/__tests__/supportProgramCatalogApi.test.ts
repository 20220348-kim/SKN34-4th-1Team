import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowseSupportProgramsUseCase } from '../../../domain/usecases/BrowseSupportProgramsUseCase'
import type { SupportProgramCatalogFilters } from '../../../domain/entities/SupportProgramCatalog'
import { supportPrograms } from '../../fixtures/supportPrograms'
import { SupportProgramRepositoryImpl } from '../../repositories/SupportProgramRepositoryImpl'
import { browseSupportProgramsApi } from '../supportProgramCatalogApi'

const defaultCatalogFilters: SupportProgramCatalogFilters = { keyword: '', region: '', category: '', status: 'OPEN', sort: 'RECENT', page: 1, pageSize: 12,
  sourceCode: '', startupStage: '', applicantType: '', founderAge: '' }
const response = { programs: [{ ...supportPrograms[0], recommendationScore: null, matchedReasons: [] }], total: 1, page: 1, pageSize: 12, totalPages: 1, regions: ['서울'], categories: ['수출'] }
const startupProgram = { ...response.programs[0], sourceCode: 'KSTARTUP', sourceName: 'K-Startup',
  sourceUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' }
const startupOptions = { startupStages: ['3년미만'], applicantTypes: ['일반기업'], founderAges: ['만 40세 이상'] }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('공고 카탈로그 HTTP 경계', () => {
  it.each([
    { sourceCode: 'KSTARTUP' as const, programs: response.programs },
    { sourceCode: 'BIZINFO' as const, programs: [startupProgram] },
    { sourceCode: 'KSTARTUP' as const, programs: [startupProgram, ...response.programs] },
    { sourceCode: 'MSIT' as const, programs: response.programs },
    { sourceCode: 'CNTRADE_NOTICE' as const, programs: response.programs },
  ])('요청 출처와 다른 공고가 하나라도 섞이면 전체 응답을 거부한다 (%#)', async ({ sourceCode, programs }) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...response, ...startupOptions, programs, total: programs.length }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(browseSupportProgramsApi({ ...defaultCatalogFilters, sourceCode })).rejects.toThrow('요청한 출처와 응답이 다릅니다.')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('출처 전체는 여러 제공처 공고를 허용하고 출처만 선택한 빈 결과도 수용한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ...response, programs: [startupProgram, ...response.programs], total: 2 }))
      .mockResolvedValueOnce(Response.json({ ...response, programs: [], total: 0, totalPages: 0 })))
    await expect(browseSupportProgramsApi(defaultCatalogFilters)).resolves.toMatchObject({ total: 2 })
    await expect(browseSupportProgramsApi({ ...defaultCatalogFilters, sourceCode: 'KSTARTUP' })).resolves.toMatchObject({ total: 0, programs: [] })
  })

  it.each([
    { sourceCode: 'MSIT' as const, sourceUrl: 'https://www.msit.go.kr/bbs/view.do' },
    { sourceCode: 'CNTRADE_NOTICE' as const, sourceUrl: 'https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do' },
  ])('$sourceCode는 공식 URL과 기간 미확인 상태를 보존하고 선택한 상태를 그대로 요청한다', async ({ sourceCode, sourceUrl }) => {
    const undated = { ...response.programs[0], sourceCode, sourceUrl, status: 'UNKNOWN',
      applicationStartDate: null, applicationEndDate: null, applicationPeriod: '공고 원문 확인' }
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ...response, programs: [undated] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new BrowseSupportProgramsUseCase(new SupportProgramRepositoryImpl())
      .execute({ ...defaultCatalogFilters, sourceCode, status: 'UNKNOWN' })
    const params = new URL(fetchMock.mock.calls[0][0]).searchParams
    expect(params.get('sourceCode')).toBe(sourceCode)
    expect(params.get('status')).toBe('UNKNOWN')
    expect(result.programs).toEqual([undated])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['startupStage', 'applicantType', 'founderAge'] as const)('%s 전용 조건은 세 facet 중 하나라도 없는 구 서버 응답을 거부한다', async (field) => {
    const command = { ...defaultCatalogFilters, sourceCode: 'KSTARTUP' as const, [field]: '조건' }
    for (const missing of ['startupStages', 'applicantTypes', 'founderAges'] as const) {
      const body: Record<string, unknown> = { ...response, programs: [startupProgram], ...startupOptions }
      delete body[missing]
      const fetchMock = vi.fn().mockResolvedValue(Response.json(body))
      vi.stubGlobal('fetch', fetchMock)
      await expect(browseSupportProgramsApi(command)).rejects.toThrow('K-Startup 추가 필터를 확인할 수 없는 응답입니다.')
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  })

  it('전용 조건 요청은 구 서버의 빈 결과도 거부하고 새 서버의 명시적인 빈 facet은 수용한다', async () => {
    const empty = { ...response, programs: [], total: 0, totalPages: 0 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(Response.json({ ...empty, startupStages: [], applicantTypes: [], founderAges: [] })))
    const command = { ...defaultCatalogFilters, sourceCode: 'KSTARTUP' as const, startupStage: '3년미만' }
    await expect(browseSupportProgramsApi(command)).rejects.toThrow('K-Startup 추가 필터를 확인할 수 없는 응답입니다.')
    await expect(browseSupportProgramsApi(command)).resolves.toMatchObject({ total: 0, startupStages: [], applicantTypes: [], founderAges: [] })
  })

  it('K-Startup의 추가 조건과 전체 선택지를 보존하고 빈 필터는 전송하지 않는다', async () => {
    const options = { startupStages: ['예비창업자', '3년미만'], applicantTypes: ['일반인'], founderAges: ['만 40세 이상'] }
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ ...response, programs: [startupProgram], ...options }))
    vi.stubGlobal('fetch', fetchMock)
    const command = { ...defaultCatalogFilters, sourceCode: 'KSTARTUP' as const,
      startupStage: '3년미만', applicantType: '일반인', founderAge: '만 40세 이상' }
    const result = await new BrowseSupportProgramsUseCase(new SupportProgramRepositoryImpl()).execute(command)
    const params = new URL(fetchMock.mock.calls[0][0]).searchParams
    for (const key of ['sourceCode', 'startupStage', 'applicantType', 'founderAge'] as const) expect(params.get(key)).toBe(command[key])
    for (const key of ['keyword', 'region', 'category']) expect(params.has(key)).toBe(false)
    expect([...params.values()].every(Boolean)).toBe(true)
    expect(result).toMatchObject(options)
    await browseSupportProgramsApi(defaultCatalogFilters)
    const allSources = new URL(fetchMock.mock.calls[1][0]).searchParams
    for (const key of ['sourceCode', 'startupStage', 'applicantType', 'founderAge']) expect(allSources.has(key)).toBe(false)
  })

  it('추가 선택지가 없는 기존 응답을 빈 배열로 정규화한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)))
    await expect(browseSupportProgramsApi(defaultCatalogFilters)).resolves.toMatchObject({
      startupStages: [], applicantTypes: [], founderAges: [],
    })
  })

  it.each([
    { startupStages: ['3년미만', '3년미만'] }, { applicantTypes: [''] },
    { founderAges: '만 40세 이상' }, { founderAges: [5] }, { startupStages: null },
  ])('잘못된 K-Startup 선택지 계약을 거부한다 (%#)', async (options) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...response, ...options })))
    await expect(browseSupportProgramsApi(defaultCatalogFilters)).rejects.toThrow()
  })

  it('키워드가 있어도 catalog GET만 사용하며 취소 신호·복합 식별자를 보존한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const useCase = new BrowseSupportProgramsUseCase(new SupportProgramRepositoryImpl())
    const result = await useCase.execute({ ...defaultCatalogFilters, keyword: ' 수출 & AI ', region: '서울', category: '수출' }, signal)
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.pathname).toBe('/api/v1/support-programs/catalog')
    expect(url.searchParams.get('keyword')).toBe('수출 & AI')
    expect(url.searchParams.get('region')).toBe('서울')
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.programs).toEqual(response.programs)
    expect(result.programs[0]).not.toBe(response.programs[0])
  })

  it.each([
    { ...response, totalPages: 2 }, { ...response, total: 3 }, { ...response, page: 2 },
    { ...response, regions: ['서울', '서울'] }, { ...response, programs: [{ ...response.programs[0], recommendationScore: 90 }] },
    { ...response, programs: [{ ...response.programs[0], sourceUrl: 'https://evil.example' }] },
    { ...response, programs: [response.programs[0], response.programs[0]], total: 2 },
  ])('모순되거나 신뢰할 수 없는 목록 계약을 거부한다 (%#)', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
    await expect(browseSupportProgramsApi(defaultCatalogFilters)).rejects.toThrow()
  })

  it('범위를 벗어난 페이지의 빈 결과와 전체 건수를 수용한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...response, programs: [], page: 2 })))
    await expect(browseSupportProgramsApi({ ...defaultCatalogFilters, page: 2 })).resolves.toMatchObject({ total: 1, programs: [], page: 2 })
  })

  it('실패를 숨기거나 AI로 재시도하지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('비밀 서버 오류', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(browseSupportProgramsApi(defaultCatalogFilters)).rejects.toThrow('공고 목록을 불러오지 못했습니다.')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
