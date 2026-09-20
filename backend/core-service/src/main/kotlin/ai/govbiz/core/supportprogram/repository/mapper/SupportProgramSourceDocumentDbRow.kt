package ai.govbiz.core.supportprogram.repository.mapper

import java.time.LocalDateTime

/** MyBatis가 공고 원문 근거 문서를 읽고 쓰기 위한 DB 행 값입니다. */
data class SupportProgramSourceDocumentDbRow(
    var sourceCode: String = "",
    var sourceProgramId: String = "",
    var sourceUrl: String = "",
    var content: String = "",
    var contentHash: String = "",
    var fetchedAt: LocalDateTime? = null,
)
