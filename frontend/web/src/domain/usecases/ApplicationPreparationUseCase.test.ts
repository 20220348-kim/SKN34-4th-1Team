import { describe, expect, it, vi } from 'vitest'
import { ApplicationPreparationUseCase } from './ApplicationPreparationUseCase'

const repository = { documents: vi.fn(), generateDocuments: vi.fn(), downloadDocument: vi.fn(), generateDraft: vi.fn(), saveContent: vi.fn(), confirmContent: vi.fn(), discoveryJobs: vi.fn(), discoveryJob: vi.fn(), availability: vi.fn(), forms: vi.fn(), discover: vi.fn(), list: vi.fn(), delete: vi.fn(), get: vi.fn(), create: vi.fn(), interpret: vi.fn(), replaceInputs: vi.fn(), updateProgress: vi.fn() }
const useCase = new ApplicationPreparationUseCase(repository)
const valid = {
  sourceCode: 'BIZINFO',
  sourceProgramId: 'PBLN_000000000118979',
  formVersionId: 'verified-form-v1',
  serviceField: 'TECHNICAL_SUPPORT' as const,
}

describe('ApplicationPreparationUseCase', () => {
  it('passes a valid immutable creation selection to the repository', () => {
    useCase.create(valid)
    expect(repository.create).toHaveBeenCalledWith(valid, undefined)
    useCase.delete(3)
    expect(repository.delete).toHaveBeenCalledWith(3, undefined)
  })

  it('rejects invalid ids and form selections before the repository', () => {
    expect(() => useCase.get(0)).toThrow('주소')
    expect(() => useCase.delete(0)).toThrow('삭제')
    expect(() => useCase.create({ ...valid, formVersionId: '잘못된 버전' })).toThrow('양식')
  })

  it('validates and forwards an independent progress revision', () => {
    useCase.updateProgress(3, { expectedProgressRevision: 2, progressStage: 'APPLIED' })
    expect(repository.updateProgress).toHaveBeenCalledWith(3, { expectedProgressRevision: 2, progressStage: 'APPLIED' }, undefined)
    expect(() => useCase.updateProgress(3, { expectedProgressRevision: 0, progressStage: 'APPLIED' })).toThrow('진행 단계')
  })

  it('accepts supported catalog identities and a manually entered BizInfo URL', () => {
    useCase.discover('BIZINFO', 'PBLN_123')
    useCase.discover('KSTARTUP', '177911')
    useCase.discover('MSIT', '3186573')
    useCase.discover('CNTRADE_NOTICE', '3862')
    useCase.discoverBizInfo('https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_456')
    expect(repository.discover).toHaveBeenNthCalledWith(1, 'BIZINFO', 'PBLN_123', undefined)
    expect(repository.discover).toHaveBeenNthCalledWith(2, 'KSTARTUP', '177911', undefined)
    expect(repository.discover).toHaveBeenNthCalledWith(3, 'MSIT', '3186573', undefined)
    expect(repository.discover).toHaveBeenNthCalledWith(4, 'CNTRADE_NOTICE', '3862', undefined)
    expect(repository.discover).toHaveBeenNthCalledWith(5, 'BIZINFO', 'PBLN_456', undefined)
    expect(() => useCase.discover('KSTARTUP', 'PBLN_123')).toThrow('지원하는 공식 공고')
    expect(() => useCase.discoverBizInfo('https://evil.example/?pblancId=PBLN_123')).toThrow('기업마당')
  })

  it('trims answers and rejects invalid section input before the repository', () => {
    useCase.interpret(1, 'company-overview', { expectedRevision: 1, requestKey: crypto.randomUUID(), message: '  우리 회사  ' })
    expect(repository.interpret).toHaveBeenCalledWith(
      1,
      'company-overview',
      expect.objectContaining({ message: '우리 회사' }),
      undefined,
    )
    expect(() => useCase.interpret(1, 'bad section', { expectedRevision: 1, requestKey: crypto.randomUUID(), message: '답변' })).toThrow('작성 항목')
  })
})
