package ai.govbiz.core.supportprogram.domain

import java.time.LocalDate

/** 이번 검색에서만 사용하는 사용자가 직접 입력한 기업 조건입니다. */
data class SupportProgramCompanyConditions(
    val region: String? = null,
    val industry: String? = null,
    val establishedOn: LocalDate? = null,
    val supportPurpose: String? = null,
    val foundedYear: Int? = null,
)
