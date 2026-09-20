package ai.govbiz.core.partner.repository.mapper

import java.time.LocalDateTime
import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

/** 파트너 제안 MySQL SQL을 실행하는 MyBatis Mapper입니다. */
@Mapper
interface PartnerProposalMapper {

    fun insertProposal(row: PartnerProposalDbRow): Int

    fun findProposalById(@Param("id") id: Long): PartnerProposalDbRow?

    fun findProposalsByProposer(@Param("accountId") accountId: Long): List<PartnerProposalDbRow>

    fun findProposalsByOwner(@Param("accountId") accountId: Long): List<PartnerProposalDbRow>

    fun findProposalByRecruitmentAndProposer(
        @Param("recruitmentId") recruitmentId: Long,
        @Param("accountId") accountId: Long,
    ): PartnerProposalDbRow?

    /** 철회하지 않은 제안 수를 모집글별로 셉니다. 빈 목록은 넘기지 않습니다. */
    fun countProposalsByRecruitmentIds(@Param("recruitmentIds") recruitmentIds: List<Long>): List<ProposalCountDbRow>

    /** 아직 응답·철회되지 않은 제안에만 결정을 기록합니다. 영향받은 행 수가 0이면 이미 처리된 것입니다. */
    fun updateDecision(
        @Param("id") id: Long,
        @Param("decision") decision: String,
        @Param("respondedAt") respondedAt: LocalDateTime,
    ): Int

    fun markWithdrawn(
        @Param("id") id: Long,
        @Param("withdrawnAt") withdrawnAt: LocalDateTime,
    ): Int

    fun markWithdrawnByProposer(
        @Param("accountId") accountId: Long,
        @Param("withdrawnAt") withdrawnAt: LocalDateTime,
    ): Int
}
