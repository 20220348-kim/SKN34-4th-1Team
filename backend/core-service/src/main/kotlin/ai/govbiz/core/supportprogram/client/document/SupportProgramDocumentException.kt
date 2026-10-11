package ai.govbiz.core.supportprogram.client.document

/** 공식 첨부 수집·파싱 경계의 안정적인 실패 분류입니다. [warnings]는 실패 전까지 모은 사용자 안내(받지 못한 첨부 등)입니다. */
class SupportProgramDocumentException(val reason: Reason, cause: Throwable? = null, val warnings: List<String> = emptyList()) : RuntimeException(null, cause) {
    /** [excludedLabel]은 자동 분석에서 뺀 첨부를 사용자에게 알릴 때 쓰는 이유입니다. 분류 이름은 화면에 내보내지 않습니다. */
    enum class Reason(val excludedLabel: String) {
        UNSUPPORTED("글자를 읽을 수 없는 문서(스캔·암호 PDF 등)"),
        NOT_FOUND("받을 수 없는 문서"),
        UNAVAILABLE("지금 받을 수 없는 문서"),
        INVALID("형식을 확인할 수 없는 문서"),
        TOO_LARGE("분량이 자동 분석 한도를 넘는 문서"),
    }
}
