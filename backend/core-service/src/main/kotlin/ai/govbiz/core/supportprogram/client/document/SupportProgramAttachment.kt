package ai.govbiz.core.supportprogram.client.document

/** 공식 공고 페이지가 직접 연결한 분석 대상 첨부입니다. */
data class SupportProgramAttachment(
    val sourceUrl: String,
    val fileName: String,
    val format: String,
    val bytes: ByteArray,
)

data class SupportProgramAttachments(
    val programTitle: String,
    val files: List<SupportProgramAttachment>,
    val warnings: List<String>,
    /** 첨부 다운로드 주소와 구분되는, 검증을 마친 공식 공고 상세 주소입니다. */
    val sourcePageUrl: String? = null,
)

const val MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES = 16 * 1024 * 1024
const val MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES = 32 * 1024 * 1024
