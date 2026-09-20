package ai.govbiz.core.partner.domain

import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver
import java.time.LocalDate
import java.time.LocalDateTime

/** 컨소시엄에서 맡는 역할입니다. 모집글은 우리 역할 하나와 찾는 역할 하나를 가집니다. */
enum class PartnerRole {
    LEAD,
    PARTICIPANT,
    DEMAND,
}

/** 저장하지 않고 마감일·공고 상태·수동 마감으로 조회 시점에 계산하는 모집 상태입니다. */
enum class PartnerRecruitmentStatus {
    OPEN,
    CLOSED,
}

/** 작성자가 입력하는 모집글 내용입니다. 작성과 수정이 같은 규칙을 씁니다. */
data class PartnerRecruitmentInput(
    val title: String,
    val body: String,
    val ownRole: PartnerRole,
    val seekingRole: PartnerRole,
    val seekingCount: Int,
    val region: String,
    /** 찾는 기업에 바라는 최소 업력(년)입니다. null이면 무관입니다. */
    val minimumCompanyAgeYears: Int?,
    val capabilities: List<String>,
    val recruitmentDeadline: LocalDate,
) {
    init {
        require(title.isNotBlank() && title == title.trim() && title.length <= MAX_TITLE_LENGTH) {
            "title must be a trimmed 1~$MAX_TITLE_LENGTH character text"
        }
        require(body.isNotBlank() && body.length <= MAX_BODY_LENGTH) { "body must be 1~$MAX_BODY_LENGTH characters" }
        require(ownRole != PartnerRole.DEMAND) { "ownRole must be LEAD or PARTICIPANT" }
        require(seekingCount in SEEKING_COUNT_RANGE) { "seekingCount must be in $SEEKING_COUNT_RANGE" }
        require(region.isNotBlank() && region == region.trim() && region.length <= MAX_REGION_LENGTH) {
            "region must be a trimmed 1~$MAX_REGION_LENGTH character text"
        }
        require(minimumCompanyAgeYears == null || minimumCompanyAgeYears in COMPANY_AGE_YEARS_RANGE) {
            "minimumCompanyAgeYears must be null or in $COMPANY_AGE_YEARS_RANGE"
        }
        require(capabilities.size <= MAX_CAPABILITY_COUNT) { "capabilities must have at most $MAX_CAPABILITY_COUNT items" }
        require(capabilities.all { it.isNotBlank() && it == it.trim() && it.length <= MAX_CAPABILITY_LENGTH }) {
            "each capability must be a trimmed 1~$MAX_CAPABILITY_LENGTH character text"
        }
        require(capabilities.toSet().size == capabilities.size) { "capabilities must not repeat" }
    }

    companion object {
        const val MAX_TITLE_LENGTH = 80
        const val MAX_BODY_LENGTH = 2000
        const val MAX_REGION_LENGTH = 20
        const val MAX_CAPABILITY_COUNT = 10
        const val MAX_CAPABILITY_LENGTH = 30
        val SEEKING_COUNT_RANGE: IntRange = 1..9
        val COMPANY_AGE_YEARS_RANGE: IntRange = 1..50
    }
}

/** 모집글에 묶인 공고입니다. 접수 마감일이 지나면 모집도 끝나므로 마감 규칙을 여기서 계산합니다. */
data class PartnerRecruitmentProgram(
    val id: Long,
    val sourceCode: String,
    val sourceProgramId: String,
    val title: String,
    val organization: String,
    val summary: String,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationStartDate: LocalDate?,
    val applicationEndDate: LocalDate?,
    val sourceUrl: String,
) {
    fun isClosedOn(today: LocalDate): Boolean =
        SupportProgramStatusResolver.resolve(applicationPeriod, applicationStartDate, applicationEndDate, today) ==
            SupportProgramStatus.CLOSED

    /** 날짜 입력에는 시간이 없으므로 접수 마감 전날이 고를 수 있는 마지막 모집 마감일입니다. 접수 마감일이 없으면 제한하지 않습니다. */
    val latestRecruitmentDeadline: LocalDate?
        get() = applicationEndDate?.minusDays(1)
}

/** 모집글에 표시되는 작성 기업입니다. 담당자 이름·연락처는 제안을 수락한 뒤에만 공개하므로 두지 않습니다. */
data class PartnerRecruitmentCompany(
    val companyName: String,
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val isEmailVerified: Boolean,
)

/** 저장 직전의 새 모집글입니다. 공고·기업은 Service가 확인한 식별자를 넘깁니다. */
data class NewPartnerRecruitment(
    val accountId: Long,
    val companyId: Long,
    val supportProgramId: Long,
    val content: PartnerRecruitmentInput,
)

/** 저장된 모집글입니다. 제안 수와 조회 시점 상태는 [PartnerRecruitmentView]가 붙입니다. */
data class PartnerRecruitment(
    val id: Long,
    val accountId: Long,
    val company: PartnerRecruitmentCompany,
    val program: PartnerRecruitmentProgram,
    val content: PartnerRecruitmentInput,
    val closedAt: LocalDateTime?,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
) {
    fun status(today: LocalDate): PartnerRecruitmentStatus =
        resolveRecruitmentStatus(closedAt, content.recruitmentDeadline, program, today)

    fun isOwnedBy(accountId: Long?): Boolean = accountId != null && accountId == this.accountId
}

/** 수동 마감, 모집 마감일 경과, 공고 접수 마감 중 하나면 마감입니다. 모집글과 제안이 같은 규칙을 씁니다. */
internal fun resolveRecruitmentStatus(
    closedAt: LocalDateTime?,
    recruitmentDeadline: LocalDate,
    program: PartnerRecruitmentProgram,
    today: LocalDate,
): PartnerRecruitmentStatus =
    if (closedAt != null || today.isAfter(recruitmentDeadline) || program.isClosedOn(today)) {
        PartnerRecruitmentStatus.CLOSED
    } else {
        PartnerRecruitmentStatus.OPEN
    }
