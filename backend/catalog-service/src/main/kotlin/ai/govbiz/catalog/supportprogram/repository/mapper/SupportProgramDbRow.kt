package ai.govbiz.catalog.supportprogram.repository.mapper

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
    var applicationMethod: String? = null,
    var applicationUrl: String? = null,
    var applicationRouteType: String = "UNKNOWN",
    var contactDepartment: String? = null,
    var contactPhoneNumber: String? = null,
    var contactText: String? = null,
    var preferenceDescription: String? = null,
    var supervisingInstitutionType: String? = null,
    var sourceSortTimestamp: String? = null,
    var startupDetailsJson: String? = null,
)
