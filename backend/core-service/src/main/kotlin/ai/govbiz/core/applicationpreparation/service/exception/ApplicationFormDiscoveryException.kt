package ai.govbiz.core.applicationpreparation.service.exception

/** [warnings]는 양식을 만들지 못했어도 사용자에게 알려야 하는 수집·분석 안내입니다(예: 받지 못한 ZIP 첨부). */
class ApplicationFormDiscoveryException(
    val reason: Reason,
    cause: Throwable? = null,
    val warnings: List<String> = emptyList(),
) : RuntimeException(cause) {
    enum class Reason {
        SOURCE_CHANGED, SOURCE_UNSUPPORTED, SOURCE_NOT_FOUND, SOURCE_UNAVAILABLE, SOURCE_INVALID, SOURCE_TOO_LARGE, NO_FORM,
        QUEUE_UNAVAILABLE, JOB_NOT_FOUND, JOB_CONFLICT, JOB_CAPACITY, AI_INVALID_RESPONSE,
    }
}
