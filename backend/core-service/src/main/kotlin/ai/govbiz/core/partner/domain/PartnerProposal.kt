package ai.govbiz.core.partner.domain

import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime

/** 저장하지 않고 응답·철회·경과 시간·모집 상태로 조회 시점에 계산하는 제안 상태입니다. */
enum class PartnerProposalStatus {
    PENDING,
    ACCEPTED,
    DECLINED,
    WITHDRAWN,
    EXPIRED,
}

/** 제안함 종류입니다. 받은 제안은 내 모집글로 온 것, 보낸 제안은 내가 제안자인 것입니다. */
enum class PartnerProposalBox {
    RECEIVED,
    SENT,
}

/** 조회 시각 기준으로 상태와 연락처 공개 여부를 계산해 둔 제안입니다. Service가 만들고 응답은 이 값을 그대로 씁니다. */
data class PartnerProposalView(
    val proposal: PartnerProposal,
    val status: PartnerProposalStatus,
    val recruitmentStatus: PartnerRecruitmentStatus,
    val revealsContacts: Boolean,
)

/** 모집글 작성자가 내린 결정입니다. 저장되는 두 값만 가집니다. */
enum class PartnerProposalDecision {
    ACCEPTED,
    DECLINED,
}

/** 제안자가 입력하는 내용입니다. */
data class PartnerProposalInput(
    val message: String,
    val shareProfile: Boolean,
) {
    init {
        require(message.isNotBlank() && message == message.trim() && message.length <= MAX_MESSAGE_LENGTH) {
            "message must be a trimmed 1~$MAX_MESSAGE_LENGTH character text"
        }
    }

    companion object {
        const val MAX_MESSAGE_LENGTH = 500
    }
}

/** 저장 직전의 새 제안입니다. 모집글·기업은 Service가 확인한 식별자를 넘깁니다. */
data class NewPartnerProposal(
    val recruitmentId: Long,
    val proposerAccountId: Long,
    val proposerCompanyId: Long,
    val content: PartnerProposalInput,
)

/** 제안의 한쪽 당사자입니다. 이메일은 수락된 뒤에만 상대에게 보여 줍니다. */
data class PartnerProposalParty(
    val accountId: Long,
    val email: String,
    val companyName: String,
    val businessNumber: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val homepageUrl: String?,
    val isEmailVerified: Boolean,
)

/** 제안이 묶인 모집글의 요약입니다. 모집이 끝나면 대기 중 제안도 만료로 봅니다. */
data class PartnerProposalRecruitment(
    val id: Long,
    val title: String,
    val recruitmentDeadline: LocalDate,
    val closedAt: LocalDateTime?,
    val program: PartnerRecruitmentProgram,
) {
    fun status(today: LocalDate): PartnerRecruitmentStatus =
        resolveRecruitmentStatus(closedAt, recruitmentDeadline, program, today)
}

/** 저장된 제안입니다. 담당자 연락처 공개 여부는 상태로만 정합니다. */
data class PartnerProposal(
    val id: Long,
    val recruitment: PartnerProposalRecruitment,
    val proposer: PartnerProposalParty,
    val owner: PartnerProposalParty,
    val content: PartnerProposalInput,
    val decision: PartnerProposalDecision?,
    val respondedAt: LocalDateTime?,
    val withdrawnAt: LocalDateTime?,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
) {
    /** 응답이 없으면 이 시각에 만료됩니다. */
    val expiresAt: LocalDateTime
        get() = createdAt.plus(RESPONSE_WINDOW)

    fun status(now: LocalDateTime): PartnerProposalStatus =
        when {
            withdrawnAt != null -> PartnerProposalStatus.WITHDRAWN
            decision == PartnerProposalDecision.ACCEPTED -> PartnerProposalStatus.ACCEPTED
            decision == PartnerProposalDecision.DECLINED -> PartnerProposalStatus.DECLINED
            now.isAfter(expiresAt) -> PartnerProposalStatus.EXPIRED
            recruitment.status(now.toLocalDate()) == PartnerRecruitmentStatus.CLOSED -> PartnerProposalStatus.EXPIRED
            else -> PartnerProposalStatus.PENDING
        }

    fun isProposedBy(accountId: Long): Boolean = proposer.accountId == accountId

    fun isOwnedBy(accountId: Long): Boolean = owner.accountId == accountId

    /** 수락된 제안만 양쪽 담당자 이메일과 기업 기본정보를 서로에게 공개합니다. */
    fun revealsContacts(now: LocalDateTime): Boolean = status(now) == PartnerProposalStatus.ACCEPTED

    companion object {
        val RESPONSE_WINDOW: Duration = Duration.ofDays(7)
    }
}
