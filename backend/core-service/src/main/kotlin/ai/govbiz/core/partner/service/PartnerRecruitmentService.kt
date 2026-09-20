package ai.govbiz.core.partner.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.partner.domain.MyPartnerProposal
import ai.govbiz.core.partner.domain.NewPartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitment
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentPage
import ai.govbiz.core.partner.domain.PartnerRecruitmentQuery
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.repository.PartnerProposalRepository
import ai.govbiz.core.partner.repository.PartnerRecruitmentRepository
import ai.govbiz.core.partner.service.exception.CompanyRequiredException
import ai.govbiz.core.partner.service.exception.RecruitmentActionForbiddenException
import ai.govbiz.core.partner.service.exception.RecruitmentAlreadyExistsException
import ai.govbiz.core.partner.service.exception.RecruitmentClosedException
import ai.govbiz.core.partner.service.exception.RecruitmentDeadlineNotAllowedException
import ai.govbiz.core.partner.service.exception.RecruitmentNotFoundException
import ai.govbiz.core.partner.service.exception.RecruitmentProgramClosedException
import ai.govbiz.core.partner.service.exception.RecruitmentProgramNotFoundException
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service

/**
 * 파트너 모집글 작성·수정·마감·조회입니다. 작성은 기업을 등록한 회원만 할 수 있고, 모집글은 제공처에 현재 있는 공고 하나에 묶입니다.
 * 모집 마감일은 오늘 이후이면서 공고 접수 마감 전날까지만 허용하며, 수정·마감은 작성자만 모집 중인 글에 할 수 있습니다.
 */
@Service
class PartnerRecruitmentService(
    private val recruitmentRepository: PartnerRecruitmentRepository,
    private val proposalRepository: PartnerProposalRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    fun create(account: Account, sourceCode: String, sourceProgramId: String, content: PartnerRecruitmentInput): PartnerRecruitmentView {
        val company = account.company ?: throw CompanyRequiredException()
        val program = recruitmentRepository.findPresentProgram(sourceCode, sourceProgramId)
            ?: throw RecruitmentProgramNotFoundException()
        val today = LocalDate.now(clock)
        if (program.isClosedOn(today)) throw RecruitmentProgramClosedException()

        val latestAllowed = program.latestRecruitmentDeadline
        val deadline = content.recruitmentDeadline
        if (deadline.isBefore(today) || (latestAllowed != null && deadline.isAfter(latestAllowed))) {
            throw RecruitmentDeadlineNotAllowedException(latestAllowed)
        }

        val recruitment = try {
            recruitmentRepository.create(
                NewPartnerRecruitment(
                    accountId = account.id,
                    companyId = company.id,
                    supportProgramId = program.id,
                    content = content,
                ),
            )
        } catch (exception: DuplicateKeyException) {
            throw RecruitmentAlreadyExistsException()
        }
        return PartnerRecruitmentView(recruitment, recruitment.status(today), proposalCount = 0, myProposal = null)
    }

    fun find(id: Long): PartnerRecruitment =
        recruitmentRepository.findById(id) ?: throw RecruitmentNotFoundException()

    /** 작성자만 모집 중인 글을 고칩니다. 묶인 공고는 바꾸지 않으며 마감일 규칙은 작성과 같습니다. */
    fun update(account: Account, id: Long, content: PartnerRecruitmentInput): PartnerRecruitmentView {
        val recruitment = findOwned(account, id)
        val today = LocalDate.now(clock)
        if (recruitment.status(today) == PartnerRecruitmentStatus.CLOSED) throw RecruitmentClosedException()
        val latestAllowed = recruitment.program.latestRecruitmentDeadline
        val deadline = content.recruitmentDeadline
        if (deadline.isBefore(today) || (latestAllowed != null && deadline.isAfter(latestAllowed))) {
            throw RecruitmentDeadlineNotAllowedException(latestAllowed)
        }
        recruitmentRepository.update(id, content, LocalDateTime.now(clock))
        return findView(id, account.id)
    }

    /** 작성자가 모집을 수동으로 마감합니다. 이미 끝난 글은 다시 마감하지 않고, 대기 중인 제안은 조회 시점에 만료로 계산됩니다. */
    fun close(account: Account, id: Long): PartnerRecruitmentView {
        val recruitment = findOwned(account, id)
        val now = LocalDateTime.now(clock)
        if (recruitment.status(now.toLocalDate()) == PartnerRecruitmentStatus.CLOSED) throw RecruitmentClosedException()
        recruitmentRepository.close(id, now)
        return findView(id, account.id)
    }

    private fun findOwned(account: Account, id: Long): PartnerRecruitment {
        val recruitment = find(id)
        if (!recruitment.isOwnedBy(account.id)) throw RecruitmentActionForbiddenException()
        return recruitment
    }

    /** 상세에는 조회 시점 상태, 제안 수, 조회한 회원의 제안을 붙입니다. 비로그인은 내 제안이 없습니다. */
    fun findView(id: Long, viewerAccountId: Long?): PartnerRecruitmentView {
        val recruitment = find(id)
        val now = LocalDateTime.now(clock)
        val myProposal = viewerAccountId?.let { proposalRepository.findByRecruitmentAndProposer(recruitment.id, it) }
        return PartnerRecruitmentView(
            recruitment = recruitment,
            status = recruitment.status(now.toLocalDate()),
            proposalCount = proposalRepository.countByRecruitmentIds(listOf(recruitment.id))[recruitment.id] ?: 0,
            myProposal = myProposal?.let { MyPartnerProposal(id = it.id, status = it.status(now)) },
        )
    }

    /** 목록에는 상태와 제안 수만 붙입니다. 내 제안 여부는 상세에서 확인합니다. */
    fun findPage(query: PartnerRecruitmentQuery): PartnerRecruitmentPage {
        val today = LocalDate.now(clock)
        val slice = recruitmentRepository.findSlice(query)
        val counts = proposalRepository.countByRecruitmentIds(slice.recruitments.map { it.id })
        return PartnerRecruitmentPage(
            recruitments = slice.recruitments.map { PartnerRecruitmentView(it, it.status(today), counts[it.id] ?: 0, myProposal = null) },
            total = slice.total,
            page = query.page,
            pageSize = query.pageSize,
        )
    }
}
