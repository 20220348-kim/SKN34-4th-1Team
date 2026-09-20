package ai.govbiz.core.applicationpreparation.service.exception

class ApplicationFormDiscoveryException(val reason: Reason, cause: Throwable? = null) : RuntimeException(cause) {
    enum class Reason {
        SOURCE_CHANGED, SOURCE_UNSUPPORTED, SOURCE_NOT_FOUND, SOURCE_UNAVAILABLE, SOURCE_INVALID, SOURCE_TOO_LARGE, NO_FORM,
        QUEUE_UNAVAILABLE, JOB_NOT_FOUND, JOB_CONFLICT, JOB_CAPACITY, AI_INVALID_RESPONSE,
    }
}
