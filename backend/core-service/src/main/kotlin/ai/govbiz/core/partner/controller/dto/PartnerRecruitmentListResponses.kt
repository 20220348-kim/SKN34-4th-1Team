package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerRecruitmentPage
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.domain.PartnerRole
import java.time.format.DateTimeFormatter

/** 목록 카드가 필요로 하는 모집글 요약입니다. 본문·공고 원문·내 제안은 상세에서만 내려줍니다. */
data class PartnerRecruitmentSummaryResponse(
    val id: Long,
    val title: String,
    val seekingRole: PartnerRole,
    val seekingCount: Int,
    val region: String,
    val capabilities: List<String>,
    val recruitmentDeadline: String,
    val status: PartnerRecruitmentStatus,
    val isMine: Boolean,
    val proposalCount: Int,
    val company: PartnerRecruitmentCompanyResponse,
    val program: PartnerRecruitmentProgramSummaryResponse,
    val createdAt: String,
) {
    companion object {
        private val DATE_TIME: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

        fun from(view: PartnerRecruitmentView, viewerAccountId: Long?): PartnerRecruitmentSummaryResponse {
            val recruitment = view.recruitment
            return PartnerRecruitmentSummaryResponse(
                id = recruitment.id,
                title = recruitment.content.title,
                seekingRole = recruitment.content.seekingRole,
                seekingCount = recruitment.content.seekingCount,
                region = recruitment.content.region,
                capabilities = recruitment.content.capabilities,
                recruitmentDeadline = recruitment.content.recruitmentDeadline.toString(),
                status = view.status,
                isMine = recruitment.isOwnedBy(viewerAccountId),
                proposalCount = view.proposalCount,
                company = PartnerRecruitmentCompanyResponse.from(recruitment.company),
                program = PartnerRecruitmentProgramSummaryResponse(
                    title = recruitment.program.title,
                    organization = recruitment.program.organization,
                    applicationEndDate = recruitment.program.applicationEndDate?.toString(),
                ),
                createdAt = recruitment.createdAt.format(DATE_TIME),
            )
        }
    }
}

data class PartnerRecruitmentProgramSummaryResponse(
    val title: String,
    val organization: String,
    val applicationEndDate: String?,
)

data class PartnerRecruitmentListResponse(
    val recruitments: List<PartnerRecruitmentSummaryResponse>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int,
) {
    companion object {
        fun from(page: PartnerRecruitmentPage, viewerAccountId: Long?): PartnerRecruitmentListResponse =
            PartnerRecruitmentListResponse(
                recruitments = page.recruitments.map { PartnerRecruitmentSummaryResponse.from(it, viewerAccountId) },
                total = page.total,
                page = page.page,
                pageSize = page.pageSize,
                totalPages = page.totalPages,
            )
    }
}
