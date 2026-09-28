import type { AwilixContainer } from 'awilix/browser'
import type { BrowseSupportProgramsUseCase } from '../../domain/usecases/BrowseSupportProgramsUseCase'

import type { CoreApiHealth } from '../../data/api/coreApiHealth'
import type { SessionHintStorage } from '../../data/storage/sessionHintStorage'
import type { KakaoChannelChatUrl } from '../../data/config/kakaoChannel'
import type { IsAssistantAiEnabled } from '../../data/config/assistantAi'
import type { AccountRepository } from '../../domain/repositories/AccountRepository'
import type { ApplicationPreparationRepository } from '../../domain/repositories/ApplicationPreparationRepository'
import type { ApplicationPreparationUseCase } from '../../domain/usecases/ApplicationPreparationUseCase'
import type { CompanyRepository } from '../../domain/repositories/CompanyRepository'
import type { PartnerProposalRepository } from '../../domain/repositories/PartnerProposalRepository'
import type { PartnerRecruitmentRepository } from '../../domain/repositories/PartnerRecruitmentRepository'
import type {
  GetCompanyPartnerProfileUseCase,
  UpdateCompanyPartnerProfileUseCase,
} from '../../domain/usecases/CompanyPartnerProfileUseCases'
import type {
  GetMyCompanyUseCase,
  LookupBusinessUseCase,
  RegisterCompanyUseCase,
  UpdateCompanyUseCase,
} from '../../domain/usecases/CompanyUseCases'
import type {
  BrowsePartnerRecruitmentsUseCase,
  ClosePartnerRecruitmentUseCase,
  CreatePartnerRecruitmentUseCase,
  GetPartnerRecruitmentDetailUseCase,
  UpdatePartnerRecruitmentUseCase,
} from '../../domain/usecases/PartnerRecruitmentUseCases'
import type { AdminAccountRepository } from '../../domain/repositories/AdminAccountRepository'
import type { SavedSupportProgramRepository } from '../../domain/repositories/SavedSupportProgramRepository'
import type {
  BrowseSavedSupportProgramsUseCase,
  CheckSavedSupportProgramUseCase,
  RemoveSavedSupportProgramUseCase,
  SaveSupportProgramUseCase,
} from '../../domain/usecases/SavedSupportProgramUseCases'
import type {
  BrowseAdminAccountsUseCase,
  GetAdminAccountDetailUseCase,
  GetAdminAccountStatsUseCase,
  TakeAdminAccountActionUseCase,
} from '../../domain/usecases/AdminAccountUseCases'
import type {
  BrowsePartnerProposalsUseCase,
  RespondPartnerProposalUseCase,
  SendPartnerProposalUseCase,
} from '../../domain/usecases/PartnerProposalUseCases'
import type { SampleItemRepository } from '../../domain/repositories/SampleItemRepository'
import type { SupportProgramRepository } from '../../domain/repositories/SupportProgramRepository'
import type { AskSupportProgramEvidenceQuestionUseCase } from '../../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import type {
  ChangePasswordUseCase,
  CompleteOnboardingUseCase,
  DeleteAccountUseCase,
  GetAccountDeletionPreviewUseCase,
} from '../../domain/usecases/AccountProfileUseCases'
import type { DevLogInUseCase } from '../../domain/usecases/DevLogInUseCase'
import type { CompleteOAuthSignInUseCase, StartOAuthSignInUseCase } from '../../domain/usecases/OAuthSignInUseCases'
import type { GetCurrentAccountUseCase } from '../../domain/usecases/GetCurrentAccountUseCase'
import type { GetSupportProgramDetailUseCase } from '../../domain/usecases/GetSupportProgramDetailUseCase'
import type { GetSupportProgramSearchReadinessUseCase } from '../../domain/usecases/GetSupportProgramSearchReadinessUseCase'
import type { LogInUseCase } from '../../domain/usecases/LogInUseCase'
import type { LogOutUseCase } from '../../domain/usecases/LogOutUseCase'
import type { RequestPasswordResetUseCase } from '../../domain/usecases/RequestPasswordResetUseCase'
import type { ResetPasswordUseCase } from '../../domain/usecases/ResetPasswordUseCase'
import type { SendSignupEmailCodeUseCase } from '../../domain/usecases/SendSignupEmailCodeUseCase'
import type { AskAssistantUseCase } from '../../domain/usecases/AskAssistantUseCase'
import type { AssistantRepository } from '../../domain/repositories/AssistantRepository'
import type { VerifyPasswordResetCodeUseCase } from '../../domain/usecases/VerifyPasswordResetCodeUseCase'
import type { VerifySignupEmailCodeUseCase } from '../../domain/usecases/VerifySignupEmailCodeUseCase'
import type { SignUpUseCase } from '../../domain/usecases/SignUpUseCase'
import type { PrepareSampleItemUseCase } from '../../domain/usecases/PrepareSampleItemUseCase'
import type { RestoreSupportProgramSearchUseCase } from '../../domain/usecases/RestoreSupportProgramSearchUseCase'
import type { SearchSupportProgramsUseCase } from '../../domain/usecases/SearchSupportProgramsUseCase'
import type { InterpretSupportProgramConversationUseCase } from '../../domain/usecases/InterpretSupportProgramConversationUseCase'

export type FetchCoreApiHealth = (signal?: AbortSignal) => Promise<CoreApiHealth>

/** Awilix가 생성·연결할 수 있는 전체 의존성 목록입니다. */
export type AppCradle = {
  chatConversationRepository: import('../../domain/repositories/ChatConversationRepository').ChatConversationRepository
  chatConversationUseCase: import('../../domain/usecases/ChatConversationUseCase').ChatConversationUseCase
  applicationPreparationRepository: ApplicationPreparationRepository
  applicationPreparationUseCase: ApplicationPreparationUseCase
  dailyReportRepository: import('../../domain/repositories/DailyReportRepository').DailyReportRepository
  dailyReportUseCase: import('../../domain/usecases/DailyReportUseCase').DailyReportUseCase
  combinationReviewRepository: import('../../domain/repositories/CombinationReviewRepository').CombinationReviewRepository
  combinationReviewUseCase: import('../../domain/usecases/CombinationReviewUseCase').CombinationReviewUseCase
  reviewRequestJournal: typeof import('../../data/storage/reviewRequestJournal').reviewRequestJournal
  browseSupportProgramsUseCase: BrowseSupportProgramsUseCase
  accountRepository: AccountRepository
  assistantRepository: AssistantRepository
  askAssistantUseCase: AskAssistantUseCase
  adminAccountRepository: AdminAccountRepository
  savedSupportProgramRepository: SavedSupportProgramRepository
  browseSavedSupportProgramsUseCase: BrowseSavedSupportProgramsUseCase
  checkSavedSupportProgramUseCase: CheckSavedSupportProgramUseCase
  saveSupportProgramUseCase: SaveSupportProgramUseCase
  removeSavedSupportProgramUseCase: RemoveSavedSupportProgramUseCase
  getAdminAccountStatsUseCase: GetAdminAccountStatsUseCase
  browseAdminAccountsUseCase: BrowseAdminAccountsUseCase
  getAdminAccountDetailUseCase: GetAdminAccountDetailUseCase
  takeAdminAccountActionUseCase: TakeAdminAccountActionUseCase
  browsePartnerProposalsUseCase: BrowsePartnerProposalsUseCase
  browsePartnerRecruitmentsUseCase: BrowsePartnerRecruitmentsUseCase
  companyRepository: CompanyRepository
  createPartnerRecruitmentUseCase: CreatePartnerRecruitmentUseCase
  getPartnerRecruitmentDetailUseCase: GetPartnerRecruitmentDetailUseCase
  updatePartnerRecruitmentUseCase: UpdatePartnerRecruitmentUseCase
  closePartnerRecruitmentUseCase: ClosePartnerRecruitmentUseCase
  getMyCompanyUseCase: GetMyCompanyUseCase
  lookupBusinessUseCase: LookupBusinessUseCase
  registerCompanyUseCase: RegisterCompanyUseCase
  updateCompanyUseCase: UpdateCompanyUseCase
  getCompanyPartnerProfileUseCase: GetCompanyPartnerProfileUseCase
  updateCompanyPartnerProfileUseCase: UpdateCompanyPartnerProfileUseCase
  interpretSupportProgramConversationUseCase: InterpretSupportProgramConversationUseCase
  askSupportProgramEvidenceQuestionUseCase: AskSupportProgramEvidenceQuestionUseCase
  devLogInUseCase: DevLogInUseCase
  startOAuthSignInUseCase: StartOAuthSignInUseCase
  completeOAuthSignInUseCase: CompleteOAuthSignInUseCase
  fetchCoreApiHealth: FetchCoreApiHealth
  kakaoChannelChatUrl: KakaoChannelChatUrl
  isAssistantAiEnabled: IsAssistantAiEnabled
  getCurrentAccountUseCase: GetCurrentAccountUseCase
  getSupportProgramDetailUseCase: GetSupportProgramDetailUseCase
  getSupportProgramSearchReadinessUseCase: GetSupportProgramSearchReadinessUseCase
  logInUseCase: LogInUseCase
  logOutUseCase: LogOutUseCase
  partnerProposalRepository: PartnerProposalRepository
  partnerRecruitmentRepository: PartnerRecruitmentRepository
  respondPartnerProposalUseCase: RespondPartnerProposalUseCase
  sendPartnerProposalUseCase: SendPartnerProposalUseCase
  prepareSampleItemUseCase: PrepareSampleItemUseCase
  sampleItemRepository: SampleItemRepository
  searchSupportProgramsUseCase: SearchSupportProgramsUseCase
  restoreSupportProgramSearchUseCase: RestoreSupportProgramSearchUseCase
  sessionHintStorage: SessionHintStorage
  signUpUseCase: SignUpUseCase
  requestPasswordResetUseCase: RequestPasswordResetUseCase
  verifyPasswordResetCodeUseCase: VerifyPasswordResetCodeUseCase
  resetPasswordUseCase: ResetPasswordUseCase
  sendSignupEmailCodeUseCase: SendSignupEmailCodeUseCase
  verifySignupEmailCodeUseCase: VerifySignupEmailCodeUseCase
  changePasswordUseCase: ChangePasswordUseCase
  completeOnboardingUseCase: CompleteOnboardingUseCase
  getAccountDeletionPreviewUseCase: GetAccountDeletionPreviewUseCase
  deleteAccountUseCase: DeleteAccountUseCase
  supportProgramRepository: SupportProgramRepository
}

export type AppContainer = AwilixContainer<AppCradle>
