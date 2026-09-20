package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentCompany
import ai.govbiz.core.partner.domain.PartnerRecruitmentProgram
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.domain.PartnerRole
import java.time.format.DateTimeFormatter

/** 모집글 응답입니다. 담당자 이름·연락처는 제안을 수락한 뒤에만 공개하므로 싣지 않습니다. 상태는 Service가 계산한 값입니다. */
data class PartnerRecruitmentResponse(
    val id: Long,
    val title: String,
    val body: String,
    val ownRole: PartnerRole,
    val seekingRole: PartnerRole,
    val seekingCount: Int,
    val region: String,
    val minimumCompanyAgeYears: Int?,
    val capabilities: List<String>,
    val recruitmentDeadline: String,
    val status: PartnerRecruitmentStatus,
    /** 조회한 회원이 쓴 모집글인지입니다. 비로그인이면 항상 false입니다. */
    val isMine: Boolean,
    /** 철회하지 않은 제안 수입니다. */
    val proposalCount: Int,
    /** 조회한 회원이 이 모집글에 보낸 제안입니다. 없거나 비로그인이면 null입니다. */
    val myProposal: MyPartnerProposalResponse?,
    val company: PartnerRecruitmentCompanyResponse,
    val program: PartnerRecruitmentProgramResponse,
    val createdAt: String,
    val updatedAt: String,
) {
    companion object {
        private val DATE_TIME: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

        fun from(view: PartnerRecruitmentView, viewerAccountId: Long?): PartnerRecruitmentResponse {
            val recruitment = view.recruitment
            return PartnerRecruitmentResponse(
                id = recruitment.id,
                title = recruitment.content.title,
                body = recruitment.content.body,
                ownRole = recruitment.content.ownRole,
                seekingRole = recruitment.content.seekingRole,
                seekingCount = recruitment.content.seekingCount,
                region = recruitment.content.region,
                minimumCompanyAgeYears = recruitment.content.minimumCompanyAgeYears,
                capabilities = recruitment.content.capabilities,
                recruitmentDeadline = recruitment.content.recruitmentDeadline.toString(),
                status = view.status,
                isMine = recruitment.isOwnedBy(viewerAccountId),
                proposalCount = view.proposalCount,
                myProposal = view.myProposal?.let { MyPartnerProposalResponse(id = it.id, status = it.status) },
                company = PartnerRecruitmentCompanyResponse.from(recruitment.company),
                program = PartnerRecruitmentProgramResponse.from(recruitment.program),
                createdAt = recruitment.createdAt.format(DATE_TIME),
                updatedAt = recruitment.updatedAt.format(DATE_TIME),
            )
        }
    }
}

/** 상세에 실리는 내 제안 요약입니다. 전체 내용은 제안함에서 봅니다. */
data class MyPartnerProposalResponse(
    val id: Long,
    val status: PartnerProposalStatus,
)

data class PartnerRecruitmentCompanyResponse(
    val companyName: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val isEmailVerified: Boolean,
    /** 등록 기업은 모두 사업자등록번호 조회를 거쳤습니다. */
    val isBusinessVerified: Boolean,
) {
    companion object {
        fun from(company: PartnerRecruitmentCompany): PartnerRecruitmentCompanyResponse =
            PartnerRecruitmentCompanyResponse(
                companyName = company.companyName,
                region = company.region,
                industry = company.industry,
                foundedYear = company.foundedYear,
                isEmailVerified = company.isEmailVerified,
                isBusinessVerified = true,
            )
    }
}

data class PartnerRecruitmentProgramResponse(
    val sourceCode: String,
    val sourceProgramId: String,
    val title: String,
    val organization: String,
    val summary: String,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationEndDate: String?,
    val sourceUrl: String,
) {
    companion object {
        fun from(program: PartnerRecruitmentProgram): PartnerRecruitmentProgramResponse =
            PartnerRecruitmentProgramResponse(
                sourceCode = program.sourceCode,
                sourceProgramId = program.sourceProgramId,
                title = program.title,
                organization = program.organization,
                summary = program.summary,
                targetDescription = program.targetDescription,
                applicationPeriod = program.applicationPeriod,
                applicationEndDate = program.applicationEndDate?.toString(),
                sourceUrl = program.sourceUrl,
            )
    }
}
