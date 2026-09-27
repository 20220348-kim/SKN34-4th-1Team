package ai.govbiz.core.applicationpreparation.service.dto

/** 실제 확인된 미지원 사유만 반환한다. source나 성공 review를 만들어 내지 않는다. */
data class ApplicationOnlineFormSourceCapabilityResult(
    val status: ApplicationOnlineFormSourceCapabilityStatus,
)

enum class ApplicationOnlineFormSourceCapabilityStatus {
    REQUIRES_AUTH,
    UNSUPPORTED_PROVIDER,
}