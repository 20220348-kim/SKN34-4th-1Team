package ai.govbiz.core.supportprogram.client.document

/** 공식 첨부 수집·파싱 경계의 안정적인 실패 분류입니다. */
class SupportProgramDocumentException(val reason: Reason, cause: Throwable? = null) : RuntimeException(null, cause) {
    enum class Reason { UNSUPPORTED, NOT_FOUND, UNAVAILABLE, INVALID, TOO_LARGE }
}
