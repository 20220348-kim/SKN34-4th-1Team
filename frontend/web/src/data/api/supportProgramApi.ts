import { supportProgramClient } from './supportProgramClient'

export {
  SupportProgramApiError,
  SupportProgramEvidenceApiError,
  SupportProgramInterpretationApiError,
  SupportProgramRequestApiError,
  SupportProgramSearchRestoreApiError,
  SupportProgramSearchTimeoutApiError,
} from '@govbiz/shared/data/api/supportProgramApi'

export const interpretSupportProgramConversationApi = supportProgramClient.interpretConversation
export const searchSupportProgramsApi = supportProgramClient.search
export const restoreSupportProgramSearchApi = supportProgramClient.restoreSearch
export const getSupportProgramSearchReadinessApi = supportProgramClient.getSearchReadiness
export const getSupportProgramDetailApi = supportProgramClient.getDetail
export const answerSupportProgramEvidenceQuestionApi = supportProgramClient.answerEvidenceQuestion
