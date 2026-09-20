package ai.govbiz.core.partner.repository.mapper

import java.time.LocalDate

/** 모집글을 묶을 공고를 support_program에서 읽는 DB 행 값입니다. */
data class PartnerProgramDbRow(
    var id: Long = 0L,
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var title: String = "",
    var organization: String = "",
    var summary: String = "",
    var targetDescription: String = "",
    var applicationPeriodRaw: String = "",
    var applicationStartDate: LocalDate? = null,
    var applicationEndDate: LocalDate? = null,
    var sourceUrl: String = "",
)
