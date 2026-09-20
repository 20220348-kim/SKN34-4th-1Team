package ai.govbiz.core.supportprogram.client.ai.mapper

import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexDocumentRequest
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.helper.SupportProgramIndexTextHelper

/** 색인 생성과 검색이 동일한 공고 버전을 참조하도록 검색 문서를 구성합니다. */
object SupportProgramIndexDocumentMapper {
    const val MAX_DOCUMENTS = SupportProgramIndexTextHelper.MAX_DOCUMENTS

    fun fromCatalog(candidate: CatalogSupportProgram): AiSupportProgramIndexDocumentRequest {
        val text = SupportProgramIndexTextHelper.buildText(candidate)
        return AiSupportProgramIndexDocumentRequest(
            candidate.program.sourceQualifiedId, SupportProgramIndexTextHelper.calculateContentHash(text), text,
        )
    }
}
