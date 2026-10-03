package ai.govbiz.core.supportprogram.client.document

/** 공식 첨부 수집·파싱 경계의 안정적인 실패 분류입니다. [warnings]는 실패 전까지 모은 사용자 안내(받지 못한 첨부 등)입니다. */
class SupportProgramDocumentException(val reason: Reason, cause: Throwable? = null, val warnings: List<String> = emptyList()) : RuntimeException(null, cause) {
    enum class Reason { UNSUPPORTED, NOT_FOUND, UNAVAILABLE, INVALID, TOO_LARGE }
}
