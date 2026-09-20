package ai.govbiz.core.supportprogram.domain

import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.time.LocalDateTime

/** 공식 제공처에서 가져와 근거 답변에만 쓰는 특정 공고의 원문 텍스트입니다. */
data class SupportProgramSourceDocument(
    val sourceCode: String,
    val sourceProgramId: String,
    val sourceUrl: String,
    val content: String,
    val contentHash: String,
    val fetchedAt: LocalDateTime,
) {
    init {
        require(SOURCE_CODE_PATTERN.matches(sourceCode)) { "sourceCode must be a valid provider code" }
        SupportProgram.requireCanonicalSourceProgramId(sourceProgramId)
        require(content.isNotBlank()) { "source document content must not be blank" }
        require(HASH_PATTERN.matches(contentHash)) { "contentHash must be a lowercase SHA-256 hash" }
        require(contentHash == SupportProgramContentHashHelper.sha256(content)) {
            "contentHash must match the UTF-8 source document content"
        }
    }

    val sourceQualifiedId: String
        get() = "$sourceCode:$sourceProgramId"

    private companion object {
        val SOURCE_CODE_PATTERN = Regex("[A-Z][A-Z0-9_]{0,63}")
        val HASH_PATTERN = Regex("[0-9a-f]{64}")
    }
}
