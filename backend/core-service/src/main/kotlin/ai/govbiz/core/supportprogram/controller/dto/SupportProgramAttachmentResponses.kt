package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.service.dto.SupportProgramAttachmentFileResult

/** 공고 상세의 공식 첨부 목록입니다. 원본 주소 대신 [SupportProgramAttachmentResponse.index]로 Core에서 받습니다. */
data class SupportProgramAttachmentListResponse(val items: List<SupportProgramAttachmentResponse>) {
    companion object {
        fun from(files: List<SupportProgramAttachmentFileResult>) =
            SupportProgramAttachmentListResponse(files.map { SupportProgramAttachmentResponse(it.index, it.fileName, it.extension) })
    }
}

data class SupportProgramAttachmentResponse(val index: Int, val fileName: String, val extension: String)
