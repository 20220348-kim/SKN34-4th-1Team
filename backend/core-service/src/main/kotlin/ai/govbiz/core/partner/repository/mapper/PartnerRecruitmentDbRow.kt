package ai.govbiz.core.partner.repository.mapper

import java.time.LocalDate
import java.time.LocalDateTime

/** MyBatis가 partner_recruitment 한 행을 쓰고, 기업·계정·공고를 조인해 읽는 데 사용하는 DB 행 값입니다. */
data class PartnerRecruitmentDbRow(
    var id: Long = 0L,
    var accountId: Long = 0L,
    var companyId: Long = 0L,
    var supportProgramId: Long = 0L,
    var title: String = "",
    var body: String = "",
    var ownRole: String = "",
    var seekingRole: String = "",
    var seekingCount: Int = 0,
    var region: String = "",
    var minimumCompanyAgeYears: Int? = null,
    var capabilitiesJson: String = "[]",
    var recruitmentDeadline: LocalDate? = null,
    var closedAt: LocalDateTime? = null,
    var createdAt: LocalDateTime? = null,
    var updatedAt: LocalDateTime? = null,
    var companyName: String = "",
    var companyRegion: String = "",
    var companyIndustry: String = "",
    var companyFoundedYear: Int = 0,
    var accountEmailVerifiedAt: LocalDateTime? = null,
    var programSourceCode: String = "",
    var programSourceProgramId: String = "",
    var programTitle: String = "",
    var programOrganization: String = "",
    var programSummary: String = "",
    var programTargetDescription: String = "",
    var programApplicationPeriodRaw: String = "",
    var programApplicationStartDate: LocalDate? = null,
    var programApplicationEndDate: LocalDate? = null,
    var programSourceUrl: String = "",
)
