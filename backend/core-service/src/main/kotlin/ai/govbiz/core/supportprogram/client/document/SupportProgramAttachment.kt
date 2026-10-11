package ai.govbiz.core.supportprogram.client.document

/** 공식 공고 페이지가 직접 연결한 분석 대상 첨부입니다. */
data class SupportProgramAttachment(
    val sourceUrl: String,
    val fileName: String,
    val format: String,
    val bytes: ByteArray,
    val mimeType: String? = null,
)

data class SupportProgramAttachments(
    val programTitle: String,
    val files: List<SupportProgramAttachment>,
    /** 실제로 읽지 못했거나 건너뛴 첨부처럼 이번 수집에서 빠진 범위만 담습니다. 비어 있으면 빠진 첨부가 없습니다. */
    val warnings: List<String>,
    /** 첨부 다운로드 주소와 구분되는, 검증을 마친 공식 공고 상세 주소입니다. */
    val sourcePageUrl: String? = null,
    /** 어떤 첨부를 수집하는지 알리는 고정 안내입니다. 빠진 범위가 아니므로 [warnings]와 따로 둡니다. */
    val collectionNotice: String? = null,
)

/** 공고 상세에 보여 줄 공식 첨부 한 건입니다. [url]과 [referer]는 Core가 원본을 받을 때만 쓰고 화면에는 내보내지 않습니다. */
data class SupportProgramAttachmentLink(
    val fileName: String,
    val extension: String,
    val url: String,
    val referer: String? = null,
)

const val MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES = 16 * 1024 * 1024
const val MAX_SUPPORT_PROGRAM_ATTACHMENTS_TOTAL_BYTES = 32 * 1024 * 1024
const val MAX_SUPPORT_PROGRAM_ATTACHMENT_LINKS = 30
