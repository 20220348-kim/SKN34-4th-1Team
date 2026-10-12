package ai.govbiz.core.partner.service

import ai.govbiz.core._common.domain.RegionDictionary
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.CompanyPartnerProfileRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.applicationpreparation.repository.ApplicationPreparationRepository
import ai.govbiz.core.partner.domain.PartnerMatchApplicant
import ai.govbiz.core.partner.domain.PartnerMatchConditions
import ai.govbiz.core.partner.domain.PartnerMatchMyProgram
import ai.govbiz.core.partner.domain.PartnerMatchProgram
import ai.govbiz.core.partner.domain.PartnerMatchProgramSource
import ai.govbiz.core.partner.domain.PartnerRecruitmentMatcher
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import ai.govbiz.core.partner.service.dto.PartnerRecommendationBasis
import ai.govbiz.core.partner.service.dto.PartnerRecruitmentRecommendation
import ai.govbiz.core.partner.service.dto.PartnerRecruitmentRecommendationResult
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import java.time.Clock
import java.time.LocalDate
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * 로그인한 회원에게 맞는 모집글을 고릅니다. 회사 소재지·설립연도, 협업·파트너 설정(역할·역량), 관심 공고와 신청 준비 공고,
 * 보낸 제안을 읽어 Domain 규칙([PartnerRecruitmentMatcher])으로 계산하고 AI는 부르지 않습니다.
 */
@Service
class PartnerRecruitmentRecommendationService(
    private val recruitmentRepository: PartnerRecruitmentRepository,
    private val proposalRepository: PartnerProposalRepository,
    private val companyRepository: CompanyRepository,
    private val partnerProfileRepository: CompanyPartnerProfileRepository,
    private val savedSupportProgramService: SavedSupportProgramService,
    private val preparationRepository: ApplicationPreparationRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun recommend(account: Account, conditions: PartnerMatchConditions, limit: Int): PartnerRecruitmentRecommendationResult {
        val today = LocalDate.now(clock)
        val company = companyRepository.findByAccountId(account.id)
        val profile = company?.let { partnerProfileRepository.findByCompanyId(it.id).input }
        val saved = savedSupportProgramService.list(account.id).map {
            PartnerMatchMyProgram(
                PartnerMatchProgram(it.program.sourceCode, it.program.id), it.program.title,
                PartnerMatchProgramSource.SAVED, isOpen = it.program.status != SupportProgramStatus.CLOSED,
            )
        }
        val savedKeys = saved.map { it.program }.toSet()
        // 신청 준비는 공고 제목을 따로 읽지 않습니다. 이유 문장은 모집글에 묶인 공고 제목을 씁니다.
        val prepared = preparationRepository.listOwned(account.id, null, MAX_PREPARATIONS)
            .map { PartnerMatchProgram(it.sourceCode, it.sourceProgramId) }
            .filter { it !in savedKeys }
            .distinct()
            .map { PartnerMatchMyProgram(it, title = "", PartnerMatchProgramSource.PREPARATION, isOpen = true) }
        val applicant = PartnerMatchApplicant(
            accountId = account.id,
            // 시·도 하나로 읽히는 소재지만 비교합니다. 같은 이름의 구처럼 후보가 여럿이면 지역 이유·주의를 붙이지 않습니다.
            region = company?.profile?.region?.let { RegionDictionary.provincesOf(it).singleOrNull() },
            foundedYear = company?.profile?.foundedYear,
            roles = profile?.roles.orEmpty().toSet(),
            capabilities = profile?.capabilities.orEmpty(),
            programs = saved + prepared,
            proposedRecruitmentIds = proposalRepository.findSentBy(account.id)
                .filter { it.withdrawnAt == null }
                .map { it.recruitment.id }
                .toSet(),
        )
        val candidates = recruitmentRepository.findOpenCandidates(PartnerRecruitmentRepository.MAX_MATCH_CANDIDATES)
        val result = PartnerRecruitmentMatcher.match(candidates, applicant, conditions, today, limit)
        val counts = proposalRepository.countByRecruitmentIds(result.matches.map { it.recruitment.id })
        return PartnerRecruitmentRecommendationResult(
            recommendations = result.matches.map { match ->
                PartnerRecruitmentRecommendation(
                    view = PartnerRecruitmentView(match.recruitment, match.recruitment.status(today), counts[match.recruitment.id] ?: 0, myProposal = null),
                    reasons = match.reasons,
                    cautions = match.cautions,
                )
            },
            total = result.total,
            basis = PartnerRecommendationBasis(
                hasCompany = company != null,
                profileSet = profile != null,
                roles = profile?.roles.orEmpty(),
                capabilityCount = profile?.capabilities?.size ?: 0,
                myProgramCount = applicant.programs.size,
                region = applicant.region,
            ),
            relax = result.relax,
            suggestedProgram = result.suggestedProgram,
        )
    }

    companion object {
        private const val MAX_PREPARATIONS = 50
    }
}
