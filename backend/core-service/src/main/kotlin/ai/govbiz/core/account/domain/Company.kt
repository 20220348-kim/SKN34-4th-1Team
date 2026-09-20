package ai.govbiz.core.account.domain

import java.time.LocalDateTime

/**
 * 계정에 등록된 기업입니다. 상호·사업자 상태는 Bizno 조회 결과를 그대로 보관하고,
 * 소재지·업종·설립연도와 홈페이지(선택)는 담당자가 입력합니다. GovBiz는 자격을 판정하지 않습니다.
 */
data class Company(
    val id: Long,
    val accountId: Long,
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    val businessStatusCode: String,
    val profile: CompanyProfileInput,
    val businessVerifiedAt: LocalDateTime,
    val createdAt: LocalDateTime,
    val updatedAt: LocalDateTime,
) {
    init {
        requireBusinessNumber(businessNumber)
        require(companyName.isNotBlank()) { "companyName must not be blank" }
    }

    /** 세션 응답과 사이드바가 쓰는 요약입니다. */
    val summary: CompanySummary
        get() = CompanySummary(id = id, companyName = companyName, businessNumber = businessNumber)
}

/** 계정 조회에 함께 실리는 기업 요약입니다. 기업이 없으면 계정의 `company`가 null입니다. */
data class CompanySummary(
    val id: Long,
    val companyName: String,
    val businessNumber: String,
)

/** 담당자가 직접 입력하는 프로필 항목입니다. 등록과 수정이 같은 규칙을 씁니다. */
data class CompanyProfileInput(
    val region: String,
    val industry: String,
    val foundedYear: Int,
    val homepageUrl: String?,
) {
    init {
        require(region.isNotBlank() && region.length <= MAX_REGION_LENGTH) { "region must be 1~$MAX_REGION_LENGTH characters" }
        require(industry.isNotBlank() && industry.length <= MAX_INDUSTRY_LENGTH) {
            "industry must be 1~$MAX_INDUSTRY_LENGTH characters"
        }
        require(foundedYear in FOUNDED_YEAR_RANGE) { "foundedYear must be in $FOUNDED_YEAR_RANGE" }
        require(homepageUrl == null || (homepageUrl.length <= MAX_HOMEPAGE_LENGTH && HOMEPAGE_PATTERN.matches(homepageUrl))) {
            "homepageUrl must be an http(s) address of at most $MAX_HOMEPAGE_LENGTH characters"
        }
    }

    companion object {
        const val MAX_REGION_LENGTH = 40
        const val MAX_INDUSTRY_LENGTH = 80
        const val MAX_HOMEPAGE_LENGTH = 500
        /** 설립연도 하한입니다. 상한(올해)은 시계가 필요해 [ai.govbiz.core.account.service.CompanyService]가 검사합니다. */
        val FOUNDED_YEAR_RANGE: IntRange = 1900..2100
        /** 프런트와 같은 규칙입니다. `http(s)://`로 시작하고 공백이 없어야 합니다. */
        val HOMEPAGE_PATTERN: Regex = Regex("https?://\\S+", RegexOption.IGNORE_CASE)
    }
}

/** 사업자등록번호 조회를 통과한 뒤 저장 직전의 새 기업입니다. */
data class NewCompany(
    val accountId: Long,
    val businessNumber: String,
    val companyName: String,
    val businessStatus: String,
    val businessStatusCode: String,
    val profile: CompanyProfileInput,
    val businessVerifiedAt: LocalDateTime,
) {
    init {
        requireBusinessNumber(businessNumber)
        require(companyName.isNotBlank()) { "companyName must not be blank" }
    }
}

/** 사업자등록번호는 하이픈 없는 숫자 10자리로만 저장합니다. */
internal fun requireBusinessNumber(businessNumber: String) {
    require(businessNumber.length == BUSINESS_NUMBER_LENGTH && businessNumber.all(Char::isDigit)) {
        "businessNumber must be 10 digits"
    }
}

const val BUSINESS_NUMBER_LENGTH = 10
