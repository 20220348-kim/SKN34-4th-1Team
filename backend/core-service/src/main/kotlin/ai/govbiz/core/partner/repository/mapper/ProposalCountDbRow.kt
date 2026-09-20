package ai.govbiz.core.partner.repository.mapper

/** 모집글별 제안 건수를 읽는 DB 행 값입니다. */
data class ProposalCountDbRow(
    var recruitmentId: Long = 0L,
    var proposalCount: Int = 0,
)
