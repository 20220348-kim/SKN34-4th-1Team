package ai.govbiz.core.partner.repository

import ai.govbiz.core.partner.domain.NewPartnerProposal
import ai.govbiz.core.partner.domain.PartnerProposal
import ai.govbiz.core.partner.domain.PartnerProposalDecision
import ai.govbiz.core.partner.domain.PartnerProposalInput
import ai.govbiz.core.partner.domain.PartnerProposalParty
import ai.govbiz.core.partner.domain.PartnerProposalRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.repository.mapper.PartnerProposalDbRow
import ai.govbiz.core.partner.repository.mapper.PartnerProposalMapper
import java.time.Clock
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 파트너 제안을 MySQL에 저장하고, 모집글·양쪽 계정·기업·공고를 조인해 읽습니다. 한 계정은 모집글 하나에 제안 하나입니다. */
@Repository
class PartnerProposalRepository(
    private val proposalMapper: PartnerProposalMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    /**
     * 제안을 INSERT합니다. 같은 모집글에 두 번 보내는 경우는 DB UNIQUE 제약이 막고,
     * 그때의 [org.springframework.dao.DuplicateKeyException]은 호출한 Service가 변환합니다.
     */
    @Transactional
    fun create(newProposal: NewPartnerProposal): PartnerProposal {
        val now = LocalDateTime.now(clock)
        val row = PartnerProposalDbRow(
            recruitmentId = newProposal.recruitmentId,
            proposerAccountId = newProposal.proposerAccountId,
            proposerCompanyId = newProposal.proposerCompanyId,
            message = newProposal.content.message,
            shareProfile = newProposal.content.shareProfile,
            createdAt = now,
            updatedAt = now,
        )
        check(proposalMapper.insertProposal(row) == 1) { "partner_proposal row was not created" }
        return requireNotNull(findById(row.id)) { "partner_proposal row was not readable" }
    }

    fun findById(id: Long): PartnerProposal? =
        proposalMapper.findProposalById(id)?.toProposal()

    /** 내가 보낸 제안을 최근 순으로 읽습니다. */
    fun findSentBy(accountId: Long): List<PartnerProposal> =
        proposalMapper.findProposalsByProposer(accountId).map { it.toProposal() }

    /** 내 모집글로 받은 제안을 최근 순으로 읽습니다. */
    fun findReceivedBy(accountId: Long): List<PartnerProposal> =
        proposalMapper.findProposalsByOwner(accountId).map { it.toProposal() }

    fun findByRecruitmentAndProposer(recruitmentId: Long, accountId: Long): PartnerProposal? =
        proposalMapper.findProposalByRecruitmentAndProposer(recruitmentId, accountId)?.toProposal()

    /** 철회하지 않은 제안 수입니다. 제안이 없는 모집글은 0입니다. */
    fun countByRecruitmentIds(recruitmentIds: Collection<Long>): Map<Long, Int> {
        if (recruitmentIds.isEmpty()) return emptyMap()
        return proposalMapper.countProposalsByRecruitmentIds(recruitmentIds.distinct())
            .associate { it.recruitmentId to it.proposalCount }
    }

    /** 대기 중인 제안에만 결정을 기록합니다. 이미 응답·철회된 제안이면 null입니다. */
    @Transactional
    fun decide(id: Long, decision: PartnerProposalDecision): PartnerProposal? {
        if (proposalMapper.updateDecision(id, decision.name, LocalDateTime.now(clock)) == 0) return null
        return findById(id)
    }

    /** 대기 중인 제안만 철회합니다. 이미 응답·철회된 제안이면 null입니다. */
    @Transactional
    fun withdraw(id: Long): PartnerProposal? {
        if (proposalMapper.markWithdrawn(id, LocalDateTime.now(clock)) == 0) return null
        return findById(id)
    }

    /** 계정 삭제 시 이 계정이 보낸 대기 제안을 모두 철회합니다. 이미 응답·철회된 제안은 그대로입니다. */
    @Transactional
    fun withdrawAllPendingByProposer(accountId: Long, withdrawnAt: LocalDateTime): Int =
        proposalMapper.markWithdrawnByProposer(accountId, withdrawnAt)

    private fun PartnerProposalDbRow.toProposal(): PartnerProposal =
        PartnerProposal(
            id = id,
            recruitment = PartnerProposalRecruitment(
                id = recruitmentId,
                title = recruitmentTitle,
                recruitmentDeadline = requireNotNull(recruitmentDeadline) { "partner_proposal recruitmentDeadline must not be null" },
                closedAt = recruitmentClosedAt,
                program = PartnerRecruitmentProgram(
                    id = programId,
                    sourceCode = programSourceCode,
                    sourceProgramId = programSourceProgramId,
                    title = programTitle,
                    organization = programOrganization,
                    summary = programSummary,
                    targetDescription = programTargetDescription,
                    applicationPeriod = programApplicationPeriodRaw,
                    applicationStartDate = programApplicationStartDate,
                    applicationEndDate = programApplicationEndDate,
                    sourceUrl = programSourceUrl,
                ),
            ),
            proposer = PartnerProposalParty(
                accountId = proposerAccountId,
                email = proposerEmail,
                companyName = proposerCompanyName,
                businessNumber = proposerBusinessNumber,
                region = proposerRegion,
                industry = proposerIndustry,
                foundedYear = proposerFoundedYear,
                homepageUrl = proposerHomepageUrl,
                isEmailVerified = proposerEmailVerifiedAt != null,
            ),
            owner = PartnerProposalParty(
                accountId = ownerAccountId,
                email = ownerEmail,
                companyName = ownerCompanyName,
                businessNumber = ownerBusinessNumber,
                region = ownerRegion,
                industry = ownerIndustry,
                foundedYear = ownerFoundedYear,
                homepageUrl = ownerHomepageUrl,
                isEmailVerified = ownerEmailVerifiedAt != null,
            ),
            content = PartnerProposalInput(message = message, shareProfile = shareProfile),
            decision = decision?.let(PartnerProposalDecision::valueOf),
            respondedAt = respondedAt,
            withdrawnAt = withdrawnAt,
            createdAt = requireNotNull(createdAt) { "partner_proposal createdAt must not be null" },
            updatedAt = requireNotNull(updatedAt) { "partner_proposal updatedAt must not be null" },
        )
}
