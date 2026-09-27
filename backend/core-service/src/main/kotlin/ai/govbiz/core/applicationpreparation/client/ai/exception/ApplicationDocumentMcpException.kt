package ai.govbiz.core.applicationpreparation.client.ai.exception

class ApplicationDocumentMcpException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
