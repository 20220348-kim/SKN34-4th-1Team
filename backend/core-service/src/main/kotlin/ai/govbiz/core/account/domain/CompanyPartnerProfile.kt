package ai.govbiz.core.account.domain

import ai.govbiz.core.partner.domain.PartnerRole
import java.time.LocalDateTime

/**
 * 기업이 파트너 모집에서 어떤 역할과 분야로 협업할지 밝히는 설정입니다. 모집글 상세와 기업 프로필 보기에서
 * 다른 기업에게 보이며 담당자 연락처는 담지 않습니다. 등록과 수정이 같은 규칙을 씁니다.
 */
data class CompanyPartnerProfileInput(
    val roles: List<PartnerRole>,
    val interestAreas: List<String>,
    val introduction: String,
    val capabilities: List<String>,
) {
    init {
        require(roles.isNotEmpty() && roles.toSet().size == roles.size) { "roles must have 1~${PartnerRole.entries.size} distinct values" }
        require(interestAreas.size <= MAX_INTEREST_AREA_COUNT) { "interestAreas must have at most $MAX_INTEREST_AREA_COUNT items" }
        require(interestAreas.all { it.isNotBlank() && it == it.trim() && it.length <= MAX_INTEREST_AREA_LENGTH }) {
            "interestAreas must be trimmed and at most $MAX_INTEREST_AREA_LENGTH characters"
        }
        require(interestAreas.toSet().size == interestAreas.size) { "interestAreas must not repeat" }
        require(introduction == introduction.trim() && introduction.length <= MAX_INTRODUCTION_LENGTH) {
            "introduction must be trimmed and at most $MAX_INTRODUCTION_LENGTH characters"
        }
        require(capabilities.size <= MAX_CAPABILITY_COUNT) { "capabilities must have at most $MAX_CAPABILITY_COUNT items" }
        require(capabilities.all { it.isNotBlank() && it == it.trim() && it.length <= MAX_CAPABILITY_LENGTH }) {
            "capabilities must be trimmed and at most $MAX_CAPABILITY_LENGTH characters"
        }
        require(capabilities.toSet().size == capabilities.size) { "capabilities must not repeat" }
    }

    companion object {
        const val MAX_INTEREST_AREA_COUNT = 3
        const val MAX_INTEREST_AREA_LENGTH = 30
        const val MAX_INTRODUCTION_LENGTH = 200
        const val MAX_CAPABILITY_COUNT = 5
        const val MAX_CAPABILITY_LENGTH = 30
    }
}

/** 저장된 협업·파트너 설정입니다. 아직 저장한 적이 없는 기업은 null 대신 [CompanyPartnerProfile.empty]를 씁니다. */
data class CompanyPartnerProfile(
    val companyId: Long,
    val input: CompanyPartnerProfileInput?,
    val updatedAt: LocalDateTime?,
) {
    val isSet: Boolean
        get() = input != null

    companion object {
        fun empty(companyId: Long): CompanyPartnerProfile = CompanyPartnerProfile(companyId, null, null)
    }
}
