package ai.govbiz.core.supportprogram.repository.exception

class SupportProgramSearchResultStoreException(cause: Throwable? = null) :
    RuntimeException("The temporary search result store is unavailable.", cause)
