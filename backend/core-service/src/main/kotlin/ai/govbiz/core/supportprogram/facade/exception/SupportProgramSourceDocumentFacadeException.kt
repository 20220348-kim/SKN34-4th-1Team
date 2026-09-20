package ai.govbiz.core.supportprogram.facade.exception

/** 공식 원문 조회 세부 실패를 상위 서비스에 전달하는 안정적인 Facade 오류입니다. */
class SupportProgramSourceDocumentFacadeException private constructor(
    val failure: Failure,
    message: String?,
    cause: Throwable,
) : RuntimeException(message, cause) {
    enum class Failure {
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
        ): SupportProgramSourceDocumentFacadeException =
            SupportProgramSourceDocumentFacadeException(failure, message, cause)
    }
}
