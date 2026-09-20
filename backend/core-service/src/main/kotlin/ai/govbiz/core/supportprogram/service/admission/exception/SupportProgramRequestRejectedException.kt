package ai.govbiz.core.supportprogram.service.admission.exception

class SupportProgramRequestRejectedException(
    val reason: Reason,
    val retryAfterSeconds: Int,
) : RuntimeException(
    when (reason) {
        Reason.RATE_LIMITED -> "지원사업 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."
        Reason.BUSY -> "지원사업 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요."
    },
) {
    enum class Reason {
        RATE_LIMITED,
        BUSY,
    }

    init {
        require(retryAfterSeconds in 1..60) { "retryAfterSeconds must be between 1 and 60" }
    }
}
