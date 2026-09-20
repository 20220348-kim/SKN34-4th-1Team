package ai.govbiz.core.supportprogram.facade.exception

/** 공고 목록 조회 Facade가 상위 Service에 전달하는 안정적인 실패 계약입니다. */
class SupportProgramCatalogFacadeException private constructor(
    val failure: Failure,
    message: String?,
    cause: Throwable,
) : RuntimeException(message, cause) {
    enum class Failure {
        NOT_CONFIGURED,
        UPSTREAM_ERROR,
        INVALID_RESPONSE,
        UNAVAILABLE,
        TIMEOUT,
    }

    companion object {
        internal fun fromClient(
            failure: Failure,
            message: String?,
            cause: Throwable,
        ): SupportProgramCatalogFacadeException =
            SupportProgramCatalogFacadeException(failure, message, cause)
    }
}
