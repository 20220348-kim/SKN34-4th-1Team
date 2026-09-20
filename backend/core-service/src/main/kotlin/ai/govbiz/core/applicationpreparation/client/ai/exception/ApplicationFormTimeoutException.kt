package ai.govbiz.core.applicationpreparation.client.ai.exception

class ApplicationFormTimeoutException(val stage: String, cause: Throwable? = null) : RuntimeException("Application form discovery timeout", cause)
