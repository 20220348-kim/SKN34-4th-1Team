package ai.govbiz.core.applicationpreparation.service.dto

/** URL/provider의 읽기 경로 후보만 판정한다. 실제 공개 여부는 inspection 결과로 확인한다. */
data class ApplicationOnlineFormSourceCapabilityResult(
    val status: ApplicationOnlineFormSourceCapabilityStatus,
)

enum class ApplicationOnlineFormSourceCapabilityStatus {
    PUBLIC_READ_SUPPORTED,
    REQUIRES_AUTH,
    UNSUPPORTED_PROVIDER,
}
