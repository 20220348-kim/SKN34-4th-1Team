import { CombinationReviewRepositoryImpl } from '../../data/repositories/CombinationReviewRepositoryImpl'
import { ChatConversationRepositoryImpl } from '../../data/repositories/ChatConversationRepositoryImpl'
import { ApplicationPreparationRepositoryImpl } from '../../data/repositories/ApplicationPreparationRepositoryImpl'
import { DailyReportRepositoryImpl } from '../../data/repositories/DailyReportRepositoryImpl'
import { asClass } from 'awilix/browser'

import { AccountRepositoryImpl } from '../../data/repositories/AccountRepositoryImpl'
import { AssistantRepositoryImpl } from '../../data/repositories/AssistantRepositoryImpl'
import { AdminAccountRepositoryImpl } from '../../data/repositories/AdminAccountRepositoryImpl'
import { SavedSupportProgramRepositoryImpl } from '../../data/repositories/SavedSupportProgramRepositoryImpl'
import { CompanyRepositoryImpl } from '../../data/repositories/CompanyRepositoryImpl'
import { PartnerProposalRepositoryImpl } from '../../data/repositories/PartnerProposalRepositoryImpl'
import { PartnerRecruitmentRepositoryImpl } from '../../data/repositories/PartnerRecruitmentRepositoryImpl'
import { SampleItemRepositoryImpl } from '../../data/repositories/SampleItemRepositoryImpl'
import { SupportProgramRepositoryImpl } from '../../data/repositories/SupportProgramRepositoryImpl'
import type { AppContainer } from './types'

/** Data Layer의 Repository 구현체와 앱 수명주기를 등록합니다. */
export function registerRepositories(container: AppContainer) {
  container.register({
    chatConversationRepository: asClass(ChatConversationRepositoryImpl).singleton(),
    applicationPreparationRepository: asClass(ApplicationPreparationRepositoryImpl).singleton(),
    dailyReportRepository: asClass(DailyReportRepositoryImpl).singleton(),
    combinationReviewRepository: asClass(CombinationReviewRepositoryImpl).singleton(),
    accountRepository: asClass(AccountRepositoryImpl).singleton(),
    assistantRepository: asClass(AssistantRepositoryImpl).singleton(),
    adminAccountRepository: asClass(AdminAccountRepositoryImpl).singleton(),
    savedSupportProgramRepository: asClass(SavedSupportProgramRepositoryImpl).singleton(),
    companyRepository: asClass(CompanyRepositoryImpl).singleton(),
    partnerProposalRepository: asClass(PartnerProposalRepositoryImpl).singleton(),
    partnerRecruitmentRepository: asClass(PartnerRecruitmentRepositoryImpl).singleton(),
    sampleItemRepository: asClass(SampleItemRepositoryImpl).singleton(),
    supportProgramRepository: asClass(SupportProgramRepositoryImpl).singleton(),
  })
}
