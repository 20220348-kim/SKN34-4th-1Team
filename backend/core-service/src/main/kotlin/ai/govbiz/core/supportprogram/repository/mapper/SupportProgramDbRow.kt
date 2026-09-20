package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDate

/** MyBatis가 support_program 테이블의 한 행을 읽고 쓰는 데 사용하는 DB 행 값입니다. */
data class SupportProgramDbRow(
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var title: String = "",
    var organization: String = "",
    var summary: String = "",
    var categoriesJson: String = "[]",
    var regionsJson: String = "[]",
    var targetDescription: String = "",
    var applicationPeriodRaw: String = "",
    var applicationStartDate: LocalDate? = null,
    var applicationEndDate: LocalDate? = null,
    var sourceUrl: String = "",
    var sourceSortTimestamp: String? = null,
    var startupDetailsJson: String? = null,
)
