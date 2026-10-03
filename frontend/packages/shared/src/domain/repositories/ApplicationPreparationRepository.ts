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
  ApplicationDocumentGenerationJob,
  ApplicationDocumentMigrationConfirmation,
  UpdateApplicationProgress,
} from '../entities/ApplicationPreparation'

/** 화면을 떠나는 순간의 마지막 저장은 `keepalive`로 보내 브라우저가 요청을 끊지 않게 합니다. */
export type ReplaceApplicationPreparationInputsOptions = { keepalive?: boolean }

export interface ApplicationPreparationRepository {
  onlineInputGuide(id: number, signal?: AbortSignal): Promise<import('../entities/ApplicationOnlineInputGuide').ApplicationOnlineInputGuide>
  availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal): Promise<import('../entities/ApplicationPreparation').ApplicationFormAvailability>
  /** 구글 설문으로 신청하는 공고의 공개 설문 문항입니다(AI 호출 없음). 로그인해야 열리는 설문은 읽지 못해 오류입니다. */
  googleForm(sourceCode: string, sourceProgramId: string, signal?: AbortSignal): Promise<import('../entities/ApplicationGoogleForm').ApplicationGoogleForm>
  documents(id: number, signal?: AbortSignal): Promise<ApplicationDocument[]>
  /** 문서 생성 작업을 접수한다. 같은 requestKey는 같은 작업을 돌려주고, 진행 중인 작업이 있으면 409다. */
  submitDocumentJob(id: number, expectedRevision: number, signal?: AbortSignal, requestKey?: string): Promise<ApplicationDocumentGenerationJob>
  documentJob(id: number, jobId: number, signal?: AbortSignal): Promise<ApplicationDocumentGenerationJob>
  documentJobs(id: number, signal?: AbortSignal): Promise<ApplicationDocumentGenerationJob[]>
  /** 계정의 최근 문서 생성 작업(준비 건 구분 없음)입니다. 목록이 초안을 만드는 중인 준비 건을 표시할 때 읽습니다. */
  recentDocumentJobs(signal?: AbortSignal): Promise<ApplicationDocumentGenerationJob[]>
  /** 그 준비 건의 끝난 문서 생성 결과를 확인한 것으로 표시합니다. 초안 화면을 열 때 부릅니다. */
  markDocumentJobsSeen(id: number, signal?: AbortSignal): Promise<void>
  /** 그 공고의 끝난 양식 분석 결과를 확인한 것으로 표시합니다. 그 공고의 새 문서 화면을 열 때 부릅니다. */
  markDiscoveryJobsSeen(sourceCode: string, sourceProgramId: string, signal?: AbortSignal): Promise<void>
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
