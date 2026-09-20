package ai.govbiz.core.supportprogram.client.elasticsearch.mapper

import ai.govbiz.core.supportprogram.client.elasticsearch.dto.ElasticsearchSupportProgramDocumentRequest
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.helper.SupportProgramIndexTextHelper
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

object ElasticsearchSupportProgramDocumentMapper {
    fun fromCatalog(candidate: CatalogSupportProgram): ElasticsearchSupportProgramDocumentRequest {
        val text = SupportProgramIndexTextHelper.buildText(candidate)
        val hash = SupportProgramIndexTextHelper.calculateContentHash(text)
        val id = candidate.program.sourceQualifiedId
        // 길이 접두사는 원본 ID/정렬 값에 구분자가 있어도 조합을 모호하지 않게 만듭니다.
        val identity = listOf(id, hash, candidate.sortTimestamp).joinToString("") { "${it.length}:$it" }
        val versionId = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(StandardCharsets.UTF_8)))
        return ElasticsearchSupportProgramDocumentRequest(versionId, id, hash, text, candidate.sortTimestamp)
    }
}
