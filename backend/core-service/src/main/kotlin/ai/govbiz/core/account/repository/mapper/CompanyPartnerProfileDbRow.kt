package ai.govbiz.core.account.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 협업·파트너 설정 한 행을 읽고 쓰기 위한 DB 행 값입니다. 배열 컬럼은 JSON 문자열입니다. */
data class CompanyPartnerProfileDbRow(
    var companyId: Long = 0,
    var rolesJson: String = "[]",
    var interestAreasJson: String = "[]",
    var introduction: String = "",
    var capabilitiesJson: String = "[]",
    var createdAt: LocalDateTime? = null,
    var updatedAt: LocalDateTime? = null,
)
