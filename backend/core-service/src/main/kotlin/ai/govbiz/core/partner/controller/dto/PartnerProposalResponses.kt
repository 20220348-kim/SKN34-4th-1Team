package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerProposalParty
import ai.govbiz.core.partner.domain.PartnerProposalStatus
import ai.govbiz.core.partner.domain.PartnerProposalView
import ai.govbiz.core.partner.domain.PartnerRecruitmentStatus
import java.time.format.DateTimeFormatter

/**
 * 제안 응답입니다. 조회한 회원이 제안자인지 모집글 작성자인지에 따라 상대(`counterpart`)가 바뀌고,
 * 상대의 이메일과 기업 기본정보는 수락된 뒤에만 실립니다. 상태와 공개 여부는 Service가 계산한 값입니다.
 */
data class PartnerProposalResponse(
    val id: Long,
    val status: PartnerProposalStatus,
    val message: String,
    val shareProfile: Boolean,
    /** 조회한 회원이 보낸 제안이면 true, 받은 제안이면 false입니다. */
    val isSent: Boolean,
    val recruitment: PartnerProposalRecruitmentResponse,
    val counterpart: PartnerProposalCounterpartResponse,
    val createdAt: String,
    val expiresAt: String,
    val respondedAt: String?,
) {
    companion object {
        private val DATE_TIME: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE_TIME

        fun from(view: PartnerProposalView, viewerAccountId: Long): PartnerProposalResponse {
            val proposal = view.proposal
            val isSent = proposal.isProposedBy(viewerAccountId)
            val counterpart = if (isSent) proposal.owner else proposal.proposer
            // 제안자가 프로필 공유를 껐으면 수락 전까지 작성자에게 기업명만 보여 줍니다. 작성자 정보는 모집글에 이미 공개된 범위입니다.
            val showsProfile = isSent || proposal.content.shareProfile
            return PartnerProposalResponse(
                id = proposal.id,
                status = view.status,
                message = proposal.content.message,
                shareProfile = proposal.content.shareProfile,
                isSent = isSent,
                recruitment = PartnerProposalRecruitmentResponse(
                    id = proposal.recruitment.id,
                    title = proposal.recruitment.title,
                    status = view.recruitmentStatus,
                    recruitmentDeadline = proposal.recruitment.recruitmentDeadline.toString(),
                ),
                counterpart = PartnerProposalCounterpartResponse.from(counterpart, showsProfile, view.revealsContacts),
                createdAt = proposal.createdAt.format(DATE_TIME),
                expiresAt = proposal.expiresAt.format(DATE_TIME),
                respondedAt = proposal.respondedAt?.format(DATE_TIME),
            )
        }
    }
}

data class PartnerProposalRecruitmentResponse(
    val id: Long,
    val title: String,
    val status: PartnerRecruitmentStatus,
    val recruitmentDeadline: String,
)

/** 상대 기업입니다. 기본정보는 프로필 공유를 켰거나 수락됐을 때, 담당자 이메일은 수락됐을 때만 채웁니다. */
data class PartnerProposalCounterpartResponse(
    val companyName: String,
    val isEmailVerified: Boolean,
    val isBusinessVerified: Boolean,
    val profile: PartnerProposalCounterpartProfileResponse?,
    val contact: PartnerProposalContactResponse?,
) {
    companion object {
        fun from(party: PartnerProposalParty, showsProfile: Boolean, revealsContact: Boolean): PartnerProposalCounterpartResponse =
            PartnerProposalCounterpartResponse(
                companyName = party.companyName,
                isEmailVerified = party.isEmailVerified,
                isBusinessVerified = true,
                profile = if (showsProfile || revealsContact) {
                    PartnerProposalCounterpartProfileResponse(
                        region = party.region,
                        industry = party.industry,
                        foundedYear = party.foundedYear,
                        homepageUrl = party.homepageUrl,
                    )
                } else {
                    null
                },
                contact = if (revealsContact) {
                    PartnerProposalContactResponse(email = party.email, businessNumber = party.businessNumber)
                } else {
                    null
                },
            )
    }
}

data class PartnerProposalCounterpartProfileResponse(
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val homepageUrl: String?,
)

data class PartnerProposalContactResponse(
    val email: String,
    val businessNumber: String,
)
