import type {
  ApplicationForm,
  ApplicationPreparation,
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
  UpdateApplicationProgress,
} from '../entities/ApplicationPreparation'

export interface ApplicationPreparationRepository {
  availability(sourceCode: string, sourceProgramId: string, signal?: AbortSignal): Promise<import('../entities/ApplicationPreparation').ApplicationFormAvailability>
  documents(id: number, signal?: AbortSignal): Promise<ApplicationDocument[]>
  generateDocuments(id: number, expectedRevision: number, signal?: AbortSignal): Promise<ApplicationDocument[]>
  downloadDocument(id: number, fileId: number, signal?: AbortSignal): Promise<Blob>
  generateDraft(id: number, sectionKey: string, input: GenerateApplicationDraft, signal?: AbortSignal): Promise<ApplicationPreparation>
  saveContent(id: number, sectionKey: string, input: SaveApplicationContent, signal?: AbortSignal): Promise<ApplicationPreparation>
  confirmContent(id: number, sectionKey: string, input: ConfirmApplicationContent, signal?: AbortSignal): Promise<ApplicationPreparation>
  forms(signal?: AbortSignal): Promise<ApplicationForm[]>
  discover(sourceCode: string, sourceProgramId: string, signal?: AbortSignal, requestKey?: string): Promise<ApplicationFormDiscoveryJob>
  discoveryJob(id: number, signal?: AbortSignal): Promise<ApplicationFormDiscoveryJob>
  discoveryJobs(signal?: AbortSignal): Promise<ApplicationFormDiscoveryJob[]>
  list(beforeId?: number, signal?: AbortSignal): Promise<ApplicationPreparationPage>
  delete(id: number, signal?: AbortSignal): Promise<void>
  get(id: number, signal?: AbortSignal): Promise<ApplicationPreparation>
  create(input: NewApplicationPreparation, signal?: AbortSignal): Promise<ApplicationPreparation>
  interpret(id: number, sectionKey: string, input: InterpretApplicationPreparation, signal?: AbortSignal): Promise<ApplicationInterpretation>
  replaceInputs(id: number, sectionKey: string, input: ReplaceApplicationPreparationInputs, signal?: AbortSignal): Promise<ApplicationPreparation>
  updateProgress(id: number, input: UpdateApplicationProgress, signal?: AbortSignal): Promise<ApplicationPreparation>
}
