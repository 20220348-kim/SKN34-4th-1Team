package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentFieldReference
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentMappingRequest
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import org.springframework.stereotype.Service
import java.security.MessageDigest
import java.util.Base64

/** Binds official question keys to verified native locations without receiving user answers. */
@Service
class ApplicationDocumentMappingService(
    private val mcp: ApplicationDocumentMcpClient,
    private val editor: ApplicationDocumentEditor,
    private val snapshots: ApplicationFormSnapshotRepository,
) {
    fun ensure(form: ApplicationFormManifest, bytes: ByteArray, format: String): ApplicationDocumentMapSnapshot {
        val sourceHash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        if (sourceHash != form.attachmentSha256) throw ApplicationDocumentException("APPLICATION_DOCUMENT_SOURCE_CHANGED", "공식 원본이 변경되었습니다.")
        val pipeline = mcp.configuration().pipelineVersion
        val stored = snapshots.findByVersion(form.formVersionId)
        (stored?.documentMapSnapshot ?: form.documentMapSnapshot)?.takeIf { it.pipelineVersion == pipeline && it.sourceSha256 == sourceHash }?.let { return it }
        val inspection = if (format.lowercase() in setOf("pdf", "hwp")) editor.inspect(bytes, format) else null
        val fields = form.sections.flatMap { section -> section.fields.map { field ->
            AiDocumentFieldReference("${section.key}:${field.key}", "${section.title} / ${field.label}", field.guidance, field.required, field.options)
        } }
        if (fields.size !in 1..200) throw ApplicationDocumentException("APPLICATION_DOCUMENT_LIMIT_EXCEEDED", "양식 문항 수가 분석 제한을 초과했습니다.")
        val result = mcp.map(AiDocumentMappingRequest(sourceBase64 = Base64.getEncoder().encodeToString(bytes), sourceSha256 = sourceHash,
            format = format.lowercase(), scope = (form.formTitle + "\n" + form.sections.joinToString("\n") { "${it.title} | ${it.locator} | ${it.description}" }).take(30000),
            fields = fields, pdfTargets = if (format.equals("pdf", true)) inspection?.targets.orEmpty() else emptyList(),
            hwpTargets = if (format.equals("hwp", true)) inspection?.targets.orEmpty() else emptyList(),
            pageImages = inspection?.pageImages.orEmpty(), pdfFields = inspection?.pdfFields.orEmpty()))
        val targetIds = (result.documentMap["targets"] as? List<*>)?.mapNotNull { (it as? Map<*, *>)?.get("targetId") as? String }?.toSet().orEmpty()
        val unmapped = (result.documentMap["unmappedFieldIds"] as? List<*>)?.map { it as? String
            ?: throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_FAILED", "입력칸 분석 결과를 확인하지 못했습니다.") }.orEmpty()
        val boundFields = result.bindings.map { it.factId }.toSet()
        if (format.equals("hwp", true) && result.bindings.any { binding -> inspection?.targets?.none { it.id == binding.targetId && it.editable } != false })
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_FAILED", "HWP 원본에 없는 입력 위치입니다.")
        if (result.contractVersion != "application-document-mcp-v1" || result.pipelineVersion != pipeline || result.sourceSha256 != sourceHash ||
            unmapped.size != unmapped.toSet().size || unmapped.any { it in boundFields || fields.any { f -> f.id == it && f.required } } ||
            boundFields + unmapped.toSet() != fields.map { it.id }.toSet() ||
            result.bindings.any { it.targetId !in targetIds || it.targetId !in result.scopeTargetIds } || result.scopeTargetIds.any { it !in targetIds }) {
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_FAILED", "질문 항목의 실제 입력 위치를 확인하지 못했습니다.")
        }
        val snapshot = ApplicationDocumentMapSnapshot(result.contractVersion, result.pipelineVersion, result.sourceSha256,
            result.mapVersion, result.engineVersion, result.bindings, result.scopeTargetIds, result.documentMap)
        return if (stored == null) snapshot else snapshots.attachDocumentMap(form.formVersionId, snapshot)
    }
}
