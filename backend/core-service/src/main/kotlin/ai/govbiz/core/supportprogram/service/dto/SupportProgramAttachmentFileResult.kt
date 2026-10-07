package ai.govbiz.core.supportprogram.service.dto

/** 공고 상세에 보여 줄 첨부 한 건입니다. [index]로 받기를 요청하며 원본 주소는 담지 않습니다. */
data class SupportProgramAttachmentFileResult(
    val index: Int,
    val fileName: String,
    val extension: String,
)
