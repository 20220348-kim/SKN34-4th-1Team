import { CombinationReviewUseCase } from '../../domain/usecases/CombinationReviewUseCase'
import { ChatConversationUseCase } from '../../domain/usecases/ChatConversationUseCase'
import { ApplicationPreparationUseCase } from '../../domain/usecases/ApplicationPreparationUseCase'
import { DailyReportUseCase } from '../../domain/usecases/DailyReportUseCase'
import { reviewRequestJournal } from '../../data/storage/reviewRequestJournal'
import { asValue } from 'awilix/browser'
import { asFunction } from 'awilix/browser'
import { BrowseSupportProgramsUseCase } from '../../domain/usecases/BrowseSupportProgramsUseCase'

import { AskSupportProgramEvidenceQuestionUseCase } from '../../domain/usecases/AskSupportProgramEvidenceQuestionUseCase'
import {
  GetCompanyPartnerProfileUseCase,
  UpdateCompanyPartnerProfileUseCase,
} from '../../domain/usecases/CompanyPartnerProfileUseCases'
import {
  GetMyCompanyUseCase,
  LookupBusinessUseCase,
  RegisterCompanyUseCase,
  UpdateCompanyUseCase,
} from '../../domain/usecases/CompanyUseCases'
import {
  BrowsePartnerRecruitmentsUseCase,
  ClosePartnerRecruitmentUseCase,
  CreatePartnerRecruitmentUseCase,
  GetPartnerRecruitmentDetailUseCase,
  UpdatePartnerRecruitmentUseCase,
} from '../../domain/usecases/PartnerRecruitmentUseCases'
import {
  BrowseAdminAccountsUseCase,
  GetAdminAccountDetailUseCase,
  GetAdminAccountStatsUseCase,
  TakeAdminAccountActionUseCase,
} from '../../domain/usecases/AdminAccountUseCases'
import {
  BrowseSavedSupportProgramsUseCase,
  CheckSavedSupportProgramUseCase,
  RemoveSavedSupportProgramUseCase,
  SaveSupportProgramUseCase,
} from '../../domain/usecases/SavedSupportProgramUseCases'
import {
  BrowsePartnerProposalsUseCase,
  RespondPartnerProposalUseCase,
  SendPartnerProposalUseCase,
} from '../../domain/usecases/PartnerProposalUseCases'
import {
  ChangePasswordUseCase,
  DeleteAccountUseCase,
  GetAccountDeletionPreviewUseCase,
} from '../../domain/usecases/AccountProfileUseCases'
import { DevLogInUseCase } from '../../domain/usecases/DevLogInUseCase'
import { CompleteOAuthSignInUseCase, StartOAuthSignInUseCase } from '../../domain/usecases/OAuthSignInUseCases'
import { GetCurrentAccountUseCase } from '../../domain/usecases/GetCurrentAccountUseCase'
import { GetSupportProgramDetailUseCase } from '../../domain/usecases/GetSupportProgramDetailUseCase'
import { GetSupportProgramSearchReadinessUseCase } from '../../domain/usecases/GetSupportProgramSearchReadinessUseCase'
import { LogInUseCase } from '../../domain/usecases/LogInUseCase'
import { LogOutUseCase } from '../../domain/usecases/LogOutUseCase'
import { PrepareSampleItemUseCase } from '../../domain/usecases/PrepareSampleItemUseCase'
import { RestoreSupportProgramSearchUseCase } from '../../domain/usecases/RestoreSupportProgramSearchUseCase'
import { SearchSupportProgramsUseCase } from '../../domain/usecases/SearchSupportProgramsUseCase'
import { RequestPasswordResetUseCase } from '../../domain/usecases/RequestPasswordResetUseCase'
import { ResetPasswordUseCase } from '../../domain/usecases/ResetPasswordUseCase'
import { SendSignupEmailCodeUseCase } from '../../domain/usecases/SendSignupEmailCodeUseCase'
import { AskAssistantUseCase } from '../../domain/usecases/AskAssistantUseCase'
import { VerifySignupEmailCodeUseCase } from '../../domain/usecases/VerifySignupEmailCodeUseCase'
import { SignUpUseCase } from '../../domain/usecases/SignUpUseCase'
import { InterpretSupportProgramConversationUseCase } from '../../domain/usecases/InterpretSupportProgramConversationUseCase'
import type { AppContainer, AppCradle } from './types'

/** Domain UseCase와 UseCase가 필요로 하는 Repository 연결을 등록합니다. */
export function registerUseCases(container: AppContainer) {
  container.register({
    chatConversationUseCase: asFunction(({ chatConversationRepository }: Pick<AppCradle, 'chatConversationRepository'>) => new ChatConversationUseCase(chatConversationRepository)).singleton(),
    applicationPreparationUseCase: asFunction(
      ({ applicationPreparationRepository }: Pick<AppCradle, 'applicationPreparationRepository'>) => new ApplicationPreparationUseCase(applicationPreparationRepository),
    ).singleton(),
    restoreSupportProgramSearchUseCase: asFunction(
      ({ supportProgramRepository }: Pick<AppCradle, 'supportProgramRepository'>) => new RestoreSupportProgramSearchUseCase(supportProgramRepository),
    ).singleton(),
    dailyReportUseCase: asFunction(({ dailyReportRepository }: Pick<AppCradle, 'dailyReportRepository'>) => new DailyReportUseCase(dailyReportRepository)).singleton(),
    reviewRequestJournal: asValue(reviewRequestJournal),
    combinationReviewUseCase: asFunction(({ combinationReviewRepository }: Pick<AppCradle, 'combinationReviewRepository'>) => new CombinationReviewUseCase(combinationReviewRepository)).singleton(),
    browseSupportProgramsUseCase: asFunction(
      ({ supportProgramRepository }: Pick<AppCradle, 'supportProgramRepository'>) => new BrowseSupportProgramsUseCase(supportProgramRepository),
    ).singleton(),
    interpretSupportProgramConversationUseCase: asFunction(
      ({ supportProgramRepository }: Pick<AppCradle, 'supportProgramRepository'>) => new InterpretSupportProgramConversationUseCase(supportProgramRepository),
    ).singleton(),
    askSupportProgramEvidenceQuestionUseCase: asFunction(
      createAskSupportProgramEvidenceQuestionUseCase,
    ).singleton(),
    devLogInUseCase: asFunction(createDevLogInUseCase).singleton(),
    startOAuthSignInUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new StartOAuthSignInUseCase(accountRepository),
    ).singleton(),
    completeOAuthSignInUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new CompleteOAuthSignInUseCase(accountRepository),
    ).singleton(),
    browsePartnerProposalsUseCase: asFunction(
      ({ partnerProposalRepository }: Pick<AppCradle, 'partnerProposalRepository'>) => new BrowsePartnerProposalsUseCase(partnerProposalRepository),
    ).singleton(),
    respondPartnerProposalUseCase: asFunction(
      ({ partnerProposalRepository }: Pick<AppCradle, 'partnerProposalRepository'>) => new RespondPartnerProposalUseCase(partnerProposalRepository),
    ).singleton(),
    sendPartnerProposalUseCase: asFunction(
      ({ partnerProposalRepository }: Pick<AppCradle, 'partnerProposalRepository'>) => new SendPartnerProposalUseCase(partnerProposalRepository),
    ).singleton(),
    getAdminAccountStatsUseCase: asFunction(
      ({ adminAccountRepository }: Pick<AppCradle, 'adminAccountRepository'>) => new GetAdminAccountStatsUseCase(adminAccountRepository),
    ).singleton(),
    browseAdminAccountsUseCase: asFunction(
      ({ adminAccountRepository }: Pick<AppCradle, 'adminAccountRepository'>) => new BrowseAdminAccountsUseCase(adminAccountRepository),
    ).singleton(),
    getAdminAccountDetailUseCase: asFunction(
      ({ adminAccountRepository }: Pick<AppCradle, 'adminAccountRepository'>) => new GetAdminAccountDetailUseCase(adminAccountRepository),
    ).singleton(),
    takeAdminAccountActionUseCase: asFunction(
      ({ adminAccountRepository }: Pick<AppCradle, 'adminAccountRepository'>) => new TakeAdminAccountActionUseCase(adminAccountRepository),
    ).singleton(),
    browseSavedSupportProgramsUseCase: asFunction(
      ({ savedSupportProgramRepository }: Pick<AppCradle, 'savedSupportProgramRepository'>) => new BrowseSavedSupportProgramsUseCase(savedSupportProgramRepository),
    ).singleton(),
    checkSavedSupportProgramUseCase: asFunction(
      ({ savedSupportProgramRepository }: Pick<AppCradle, 'savedSupportProgramRepository'>) => new CheckSavedSupportProgramUseCase(savedSupportProgramRepository),
    ).singleton(),
    saveSupportProgramUseCase: asFunction(
      ({ savedSupportProgramRepository }: Pick<AppCradle, 'savedSupportProgramRepository'>) => new SaveSupportProgramUseCase(savedSupportProgramRepository),
    ).singleton(),
    removeSavedSupportProgramUseCase: asFunction(
      ({ savedSupportProgramRepository }: Pick<AppCradle, 'savedSupportProgramRepository'>) => new RemoveSavedSupportProgramUseCase(savedSupportProgramRepository),
    ).singleton(),
    browsePartnerRecruitmentsUseCase: asFunction(
      ({ partnerRecruitmentRepository }: Pick<AppCradle, 'partnerRecruitmentRepository'>) => new BrowsePartnerRecruitmentsUseCase(partnerRecruitmentRepository),
    ).singleton(),
    createPartnerRecruitmentUseCase: asFunction(
      ({ partnerRecruitmentRepository }: Pick<AppCradle, 'partnerRecruitmentRepository'>) => new CreatePartnerRecruitmentUseCase(partnerRecruitmentRepository),
    ).singleton(),
    getPartnerRecruitmentDetailUseCase: asFunction(
      ({ partnerRecruitmentRepository }: Pick<AppCradle, 'partnerRecruitmentRepository'>) => new GetPartnerRecruitmentDetailUseCase(partnerRecruitmentRepository),
    ).singleton(),
    updatePartnerRecruitmentUseCase: asFunction(
      ({ partnerRecruitmentRepository }: Pick<AppCradle, 'partnerRecruitmentRepository'>) => new UpdatePartnerRecruitmentUseCase(partnerRecruitmentRepository),
    ).singleton(),
    closePartnerRecruitmentUseCase: asFunction(
      ({ partnerRecruitmentRepository }: Pick<AppCradle, 'partnerRecruitmentRepository'>) => new ClosePartnerRecruitmentUseCase(partnerRecruitmentRepository),
    ).singleton(),
    getMyCompanyUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new GetMyCompanyUseCase(companyRepository),
    ).singleton(),
    lookupBusinessUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new LookupBusinessUseCase(companyRepository),
    ).singleton(),
    registerCompanyUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new RegisterCompanyUseCase(companyRepository),
    ).singleton(),
    getCompanyPartnerProfileUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new GetCompanyPartnerProfileUseCase(companyRepository),
    ).singleton(),
    updateCompanyPartnerProfileUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new UpdateCompanyPartnerProfileUseCase(companyRepository),
    ).singleton(),
    updateCompanyUseCase: asFunction(
      ({ companyRepository }: Pick<AppCradle, 'companyRepository'>) => new UpdateCompanyUseCase(companyRepository),
    ).singleton(),
    getCurrentAccountUseCase: asFunction(createGetCurrentAccountUseCase).singleton(),
    getSupportProgramDetailUseCase: asFunction(
      createGetSupportProgramDetailUseCase,
    ).singleton(),
    getSupportProgramSearchReadinessUseCase: asFunction(
      createGetSupportProgramSearchReadinessUseCase,
    ).singleton(),
    logInUseCase: asFunction(createLogInUseCase).singleton(),
    logOutUseCase: asFunction(createLogOutUseCase).singleton(),
    prepareSampleItemUseCase: asFunction(
      createPrepareSampleItemUseCase,
    ).singleton(),
    searchSupportProgramsUseCase: asFunction(
      createSearchSupportProgramsUseCase,
    ).singleton(),
    signUpUseCase: asFunction(createSignUpUseCase).singleton(),
    requestPasswordResetUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new RequestPasswordResetUseCase(accountRepository),
    ).singleton(),
    resetPasswordUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new ResetPasswordUseCase(accountRepository),
    ).singleton(),
    askAssistantUseCase: asFunction(
      ({ assistantRepository }: Pick<AppCradle, 'assistantRepository'>) => new AskAssistantUseCase(assistantRepository),
    ).singleton(),
    sendSignupEmailCodeUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new SendSignupEmailCodeUseCase(accountRepository),
    ).singleton(),
    verifySignupEmailCodeUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new VerifySignupEmailCodeUseCase(accountRepository),
    ).singleton(),
    changePasswordUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new ChangePasswordUseCase(accountRepository),
    ).singleton(),
    getAccountDeletionPreviewUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new GetAccountDeletionPreviewUseCase(accountRepository),
    ).singleton(),
    deleteAccountUseCase: asFunction(
      ({ accountRepository }: Pick<AppCradle, 'accountRepository'>) => new DeleteAccountUseCase(accountRepository),
    ).singleton(),
  })
}

function createAskSupportProgramEvidenceQuestionUseCase({
  supportProgramRepository,
}: Pick<AppCradle, 'supportProgramRepository'>): AskSupportProgramEvidenceQuestionUseCase {
  return new AskSupportProgramEvidenceQuestionUseCase(supportProgramRepository)
}

function createDevLogInUseCase({
  accountRepository,
}: Pick<AppCradle, 'accountRepository'>): DevLogInUseCase {
  return new DevLogInUseCase(accountRepository)
}

function createGetCurrentAccountUseCase({
  accountRepository,
}: Pick<AppCradle, 'accountRepository'>): GetCurrentAccountUseCase {
  return new GetCurrentAccountUseCase(accountRepository)
}

function createLogInUseCase({
  accountRepository,
}: Pick<AppCradle, 'accountRepository'>): LogInUseCase {
  return new LogInUseCase(accountRepository)
}

function createSignUpUseCase({
  accountRepository,
}: Pick<AppCradle, 'accountRepository'>): SignUpUseCase {
  return new SignUpUseCase(accountRepository)
}

function createLogOutUseCase({
  accountRepository,
}: Pick<AppCradle, 'accountRepository'>): LogOutUseCase {
  return new LogOutUseCase(accountRepository)
}

function createGetSupportProgramDetailUseCase({
  supportProgramRepository,
}: Pick<AppCradle, 'supportProgramRepository'>): GetSupportProgramDetailUseCase {
  return new GetSupportProgramDetailUseCase(supportProgramRepository)
}

function createGetSupportProgramSearchReadinessUseCase({
  supportProgramRepository,
}: Pick<AppCradle, 'supportProgramRepository'>): GetSupportProgramSearchReadinessUseCase {
  return new GetSupportProgramSearchReadinessUseCase(supportProgramRepository)
}

function createPrepareSampleItemUseCase({
  sampleItemRepository,
}: Pick<AppCradle, 'sampleItemRepository'>): PrepareSampleItemUseCase {
  return new PrepareSampleItemUseCase(sampleItemRepository)
}

function createSearchSupportProgramsUseCase({
  supportProgramRepository,
}: Pick<AppCradle, 'supportProgramRepository'>): SearchSupportProgramsUseCase {
  return new SearchSupportProgramsUseCase(supportProgramRepository)
}
