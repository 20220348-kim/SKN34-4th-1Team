import { applicationProgressStages, validateNewApplicationPreparation, type InterpretApplicationPreparation, type NewApplicationPreparation, type ReplaceApplicationPreparationInputs, type UpdateApplicationProgress } from '../entities/ApplicationPreparation'
import type { ApplicationPreparationRepository } from '../repositories/ApplicationPreparationRepository'
import type { GenerateApplicationDraft, SaveApplicationContent, ConfirmApplicationContent } from '../entities/ApplicationPreparation'

/** 지원 양식 조회와 신청 준비 건 생성·목록·상세는 AI 실행 없이 동작합니다. */
export class ApplicationPreparationUseCase {
  private readonly repository: ApplicationPreparationRepository

  constructor(repository: ApplicationPreparationRepository) {
    this.repository = repository
  }

  availability(sourceCode: string, value: string, signal?: AbortSignal) {
    const id = value.trim().startsWith('https://') ? extractBizInfoProgramId(value.trim()) : value.trim()
    if (!id) throw new Error('올바른 공고 ID를 입력해 주세요.')
    return this.repository.availability(sourceCode || 'BIZINFO', id, signal)
  }
  forms(signal?: AbortSignal) { return this.repository.forms(signal) }
  documents(id: number, signal?: AbortSignal) { return this.repository.documents(id, signal) }
  generateDocuments(id: number, revision: number, signal?: AbortSignal) { return this.repository.generateDocuments(id, revision, signal) }
  downloadDocument(id: number, fileId: number, signal?: AbortSignal) { return this.repository.downloadDocument(id, fileId, signal) }
  generateDraft(id: number, sectionKey: string, input: GenerateApplicationDraft, signal?: AbortSignal) {
    return this.repository.generateDraft(id, sectionKey, input, signal)
  }
  saveContent(id: number, sectionKey: string, input: SaveApplicationContent, signal?: AbortSignal) {
    if (!input.content.trim() || input.content.length > 15000) throw new Error('작성본은 1~15,000자로 입력해 주세요.')
    return this.repository.saveContent(id, sectionKey, input, signal)
  }
  confirmContent(id: number, sectionKey: string, input: ConfirmApplicationContent, signal?: AbortSignal) {
    return this.repository.confirmContent(id, sectionKey, input, signal)
  }
  discoveryJobs(signal?: AbortSignal) { return this.repository.discoveryJobs(signal) }
  discoveryJob(id: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('올바른 분석 작업이 아닙니다.')
    return this.repository.discoveryJob(id, signal)
  }
  discover(sourceCode: string, sourceProgramId: string, signal?: AbortSignal, requestKey?: string) {
    const normalizedSourceCode = sourceCode.trim()
    const normalizedProgramId = sourceProgramId.trim()
    const valid = normalizedSourceCode === 'BIZINFO'
      ? /^PBLN_[0-9]{1,32}$/.test(normalizedProgramId)
      : ['KSTARTUP', 'MSIT', 'CNTRADE_NOTICE'].includes(normalizedSourceCode) && /^[1-9][0-9]{0,254}$/.test(normalizedProgramId)
    if (!valid) throw new Error('신청 문서 찾기를 지원하는 공식 공고를 다시 선택해 주세요.')
    return requestKey === undefined ? this.repository.discover(normalizedSourceCode, normalizedProgramId, signal)
      : this.repository.discover(normalizedSourceCode, normalizedProgramId, signal, requestKey)
  }
  discoverBizInfo(value: string, signal?: AbortSignal, requestKey?: string) {
    const normalized = value.trim()
    const sourceProgramId = /^PBLN_[0-9]{1,32}$/.test(normalized)
      ? normalized
      : extractBizInfoProgramId(normalized)
    if (!sourceProgramId) throw new Error('기업마당 공식 공고 URL 또는 PBLN 공고 ID를 입력해 주세요.')
    return this.discover('BIZINFO', sourceProgramId, signal, requestKey)
  }
  list(beforeId?: number, signal?: AbortSignal) { return this.repository.list(beforeId, signal) }
  delete(id: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('삭제할 신청 준비 건이 올바르지 않습니다.')
    return this.repository.delete(id, signal)
  }
  get(id: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('올바른 신청 준비 주소가 아닙니다.')
    return this.repository.get(id, signal)
  }
  create(input: NewApplicationPreparation, signal?: AbortSignal) {
    return this.repository.create(validateNewApplicationPreparation(input), signal)
  }
  interpret(id: number, sectionKey: string, input: InterpretApplicationPreparation, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z][a-z0-9-]{0,63}$/.test(sectionKey)) throw new Error('올바른 작성 항목이 아닙니다.')
    if (!input.message.trim() || input.message.trim().length > 4000) throw new Error('답변을 1~4000자로 입력해 주세요.')
    return this.repository.interpret(id, sectionKey, { ...input, message: input.message.trim() }, signal)
  }
  replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z][a-z0-9-]{0,63}$/.test(sectionKey)) throw new Error('올바른 작성 항목이 아닙니다.')
    if (new Set(input.facts.map(({ fieldKey }) => fieldKey)).size !== input.facts.length) throw new Error('같은 입력 항목이 중복되었습니다.')
    return this.repository.replaceInputs(id, sectionKey, input, signal)
  }
  updateProgress(id: number, input: UpdateApplicationProgress, signal?: AbortSignal) {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(input.expectedProgressRevision) || input.expectedProgressRevision <= 0 ||
      !applicationProgressStages.includes(input.progressStage)) throw new Error('올바른 진행 단계 변경이 아닙니다.')
    return this.repository.updateProgress(id, input, signal)
  }
}

function extractBizInfoProgramId(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['bizinfo.go.kr', 'www.bizinfo.go.kr'].includes(url.hostname) ||
      url.pathname !== '/sii/siia/selectSIIA200Detail.do'
    ) return null
    const ids = url.searchParams.getAll('pblancId')
    const id = ids.length === 1 ? ids[0] : null
    return id && /^PBLN_[0-9]{1,32}$/.test(id) ? id : null
  } catch {
    return null
  }
}
