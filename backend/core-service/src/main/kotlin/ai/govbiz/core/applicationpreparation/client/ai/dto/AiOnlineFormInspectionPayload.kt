package ai.govbiz.core.applicationpreparation.client.ai.dto

data class AiOnlineFormInspectionPayload(
    val contractVersion: String,
    val parserVersion: String,
    val sourceUrl: String,
    val finalUrl: String,
    val formTitle: String,
    val semanticFingerprint: String,
    val questions: List<AiOnlineFormQuestionPayload>,
)

data class AiOnlineFormQuestionPayload(
    val order: Int,
    val controlId: String,
    /** 미리 채운 링크의 `entry.{번호}`입니다. 지원하지 않는 문항(UNKNOWN)만 null입니다. */
    val entryId: String?,
    val label: String,
    val description: String,
    val required: Boolean,
    val kind: String,
    val options: List<String>,
    /** 선택지 끝의 "기타" 자유 입력을 받는지입니다. */
    val allowsOther: Boolean,
    val supported: Boolean,
    val unsupportedReason: String?,
)
