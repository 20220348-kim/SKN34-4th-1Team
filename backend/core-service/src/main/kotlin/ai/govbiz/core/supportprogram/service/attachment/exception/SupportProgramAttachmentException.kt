package ai.govbiz.core.supportprogram.service.attachment.exception

/** 공고 상세 첨부 목록·받기의 실패 분류입니다. 원문 사이트의 세부 오류는 공개 응답에 내보내지 않습니다. */
class SupportProgramAttachmentException(val reason: Reason, cause: Throwable? = null) : RuntimeException(null, cause) {
    enum class Reason { NOT_FOUND, TOO_LARGE, UNAVAILABLE }
}
