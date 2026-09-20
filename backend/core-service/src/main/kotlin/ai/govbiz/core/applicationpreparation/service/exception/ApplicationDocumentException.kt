package ai.govbiz.core.applicationpreparation.service.exception

class ApplicationDocumentException(val code: String, message: String, cause: Throwable? = null) : RuntimeException(message, cause)
