import type {
  ApplicationForm,
  ApplicationPreparation,
  ApplicationPreparationListQuery,
  ApplicationPreparationPage,
  NewApplicationPreparation,
  InterpretApplicationPreparation,
  ReplaceApplicationPreparationInputs,
  ApplicationInterpretation,
  ApplicationFormDiscoveryJob,
  GenerateApplicationDraft,
  SaveApplicationContent,
  ConfirmApplicationContent,
  ApplicationDocument,
  ApplicationDocumentMigrationConfirmation,
  UpdateApplicationProgress,
} from '../entities/ApplicationPreparation'

/** 화면을 떠나는 순간의 마지막 저장은 `keepalive`로 보내 브라우저가 요청을 끊지 않게 합니다. */
export type ReplaceApplicationPreparationInputsOptions = { keepalive?: boolean }

export interface ApplicationPreparationRepository {
  onlineInputGuide(id: number, signal?: AbortSignal): Promise<import('../entities/ApplicationOnlineInputGuide').ApplicationOnlineInputGuide>
  availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal): Promise<import('../entities/ApplicationPreparation').ApplicationFormAvailability>
  documents(id: number, signal?: AbortSignal): Promise<ApplicationDocument[]>
  generateDocuments(id: number, expectedRevision: number, signal?: AbortSignal): Promise<ApplicationDocument[]>
  confirmDocumentMappingMigration(id: number, expectedRevision: number, approvalToken: string,
    signal?: AbortSignal): Promise<ApplicationDocumentMigrationConfirmation>
  downloadDocument(id: number, fileId: number, signal?: AbortSignal): Promise<Blob>
  /** 한 답변 버전의 파일을 모두 내려받는다. 파일이 하나면 그 파일, 여럿이면 zip이다. */
  downloadDocumentArchive(id: number, revision: number, signal?: AbortSignal): Promise<Blob>
  generateDraft(id: number, sectionKey: string, input: GenerateApplicationDraft, signal?: AbortSignal): Promise<ApplicationPreparation>
  saveContent(id: number, sectionKey: string, input: SaveApplicationContent, signal?: AbortSignal): Promise<ApplicationPreparation>
  confirmContent(id: number, sectionKey: string, input: ConfirmApplicationContent, signal?: AbortSignal): Promise<ApplicationPreparation>
  forms(signal?: AbortSignal): Promise<ApplicationForm[]>
  discover(sourceCode: string, sourceProgramId: string, signal?: AbortSignal, requestKey?: string): Promise<ApplicationFormDiscoveryJob>
  discoveryJob(id: number, signal?: AbortSignal): Promise<ApplicationFormDiscoveryJob>
  discoveryJobs(signal?: AbortSignal): Promise<ApplicationFormDiscoveryJob[]>
  list(query?: ApplicationPreparationListQuery, signal?: AbortSignal): Promise<ApplicationPreparationPage>
  delete(id: number, signal?: AbortSignal): Promise<void>
  get(id: number, signal?: AbortSignal): Promise<ApplicationPreparation>
  create(input: NewApplicationPreparation, signal?: AbortSignal): Promise<ApplicationPreparation>
  interpret(id: number, sectionKey: string, input: InterpretApplicationPreparation, signal?: AbortSignal): Promise<ApplicationInterpretation>
  replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal,
    options?: ReplaceApplicationPreparationInputsOptions): Promise<ApplicationPreparation>
  updateProgress(id: number, input: UpdateApplicationProgress, signal?: AbortSignal): Promise<ApplicationPreparation>
}
