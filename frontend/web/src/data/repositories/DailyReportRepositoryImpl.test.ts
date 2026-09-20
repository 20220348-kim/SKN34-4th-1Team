import { afterEach, describe, expect, it, vi } from 'vitest'
import { DailyReportRepositoryImpl } from './DailyReportRepositoryImpl'
import { dailyReportResponseSchema } from '../models/DailyReportDto'
import { readyReport, reportSettings } from '../../presentation/features/daily-report/testing/dailyReportFixtures'
import { DailyReportUseCase } from '../../domain/usecases/DailyReportUseCase'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('일일 리포트 API와 응답 경계', () => {
  it('설정·미리보기·최신 조회는 쿠키와 no-store를 사용하고 조회가 생성을 요청하지 않는다', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(reportSettings)).mockResolvedValueOnce(Response.json({ report: readyReport })).mockResolvedValueOnce(Response.json({ report: null }))
    vi.stubGlobal('fetch', fetcher)
    const repository = new DailyReportRepositoryImpl()
    expect(await repository.settings()).toEqual(reportSettings)
    expect(await repository.preview()).toEqual(readyReport)
    expect(await repository.latest()).toBeNull()
    expect(fetcher.mock.calls.map(([url, options]) => [new URL(url).pathname, options.method])).toEqual([
      ['/api/v1/me/daily-reports/settings', 'GET'], ['/api/v1/me/daily-reports/preview', 'POST'], ['/api/v1/me/daily-reports/latest', 'GET'],
    ])
    for (const [, options] of fetcher.mock.calls) expect(options).toMatchObject({ credentials: 'include', cache: 'no-store' })
  })

  it('이메일 토큰은 URL 대신 POST 본문으로 보내며 204만 성공으로 받는다', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json({}))
    vi.stubGlobal('fetch', fetcher)
    const repository = new DailyReportRepositoryImpl()
    const token = 'a'.repeat(43)
    await repository.emailAction('confirm', token)
    expect(fetcher.mock.calls[0][0]).not.toContain(token)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token }) })
    await expect(repository.verifyEmail()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' })
  })

  it('서버의 장애 코드를 보존하고 응답 원문은 오류 메시지에 포함하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 'DAILY_REPORT_EMAIL_UNAVAILABLE', detail: 'secret smtp error' }, { status: 503 })))
    await expect(new DailyReportRepositoryImpl().verifyEmail()).rejects.toMatchObject({ status: 503, code: 'DAILY_REPORT_EMAIL_UNAVAILABLE', message: 'DAILY_REPORT_EMAIL_UNAVAILABLE' })
  })

  it('호출 취소를 실제 요청에 전달한다', async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const request = new DailyReportRepositoryImpl().preview(controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it.each([
    ['공식 도메인 위장', (report: typeof readyReport) => { report.programs[0].sourceUrl = 'https://bizinfo.go.kr.evil.test/detail' }],
    ['다른 제공처의 인용', (report: typeof readyReport) => { report.programs[0].citations[0].sourceUrl = 'https://www.k-startup.go.kr/detail' }],
    ['근거 없는 답변 완료', (report: typeof readyReport) => { report.programs[0].citations = [] }],
    ['중복 공고', (report: typeof readyReport) => { report.programs.push(report.programs[0]) }],
    ['실패 결과를 추천으로 표시', (report: typeof readyReport) => { report.status = 'FAILED' }],
    ['점수 상한 초과', (report: typeof readyReport) => { report.programs[0].relevanceScore = 101 }],
    ['공고 3건 상한 초과', (report: typeof readyReport) => { report.programs = Array.from({ length: 4 }, (_, index) => ({ ...report.programs[0], sourceProgramId: `PBLN_${index}` })) }],
  ])('%s 응답을 거부한다', (_name, mutate) => {
    const report = structuredClone(readyReport)
    mutate(report)
    expect(dailyReportResponseSchema.safeParse({ report }).success).toBe(false)
  })

  it('같은 원본 ID라도 제공처가 다르면 별도 공고로 받는다', () => {
    const report = structuredClone(readyReport)
    report.programs.push({ ...report.programs[0], sourceCode: 'KSTARTUP', sourceUrl: 'https://www.k-startup.go.kr/detail', evidenceStatus: 'UNSUPPORTED', evidenceAnswer: null, citations: [] })
    expect(dailyReportResponseSchema.safeParse({ report }).success).toBe(true)
  })

  it('동의 누락·100자 초과·잘못된 토큰은 네트워크 호출 전에 차단한다', () => {
    const repository = new DailyReportRepositoryImpl()
    const save = vi.spyOn(repository, 'saveSettings')
    const email = vi.spyOn(repository, 'emailAction')
    const useCase = new DailyReportUseCase(repository)
    expect(() => useCase.saveSettings({ supportPurpose: 'AI', enabled: true, consent: false })).toThrow('동의')
    expect(() => useCase.saveSettings({ supportPurpose: '가'.repeat(101), enabled: false, consent: false })).toThrow('100자')
    expect(() => useCase.emailAction('confirm', 'bad-token')).toThrow('링크')
    expect(save).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
  })
})
