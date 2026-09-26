package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMappingChangeResponse
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationDocumentMigrationNoticeResponse
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMapSnapshot
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentMappingChange
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationProposal
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentMappingChangedException
import java.time.Duration
import java.util.UUID
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

/** Holds an inactive proposal long enough for its owner to compare and approve it. */
@Service
class ApplicationDocumentMigrationProposalStore(
    private val redis: StringRedisTemplate,
    private val json: ObjectMapper,
) {
    fun create(ownerId: Long, preparationId: Long, expectedRevision: Long, form: ApplicationFormManifest,
               change: ApplicationDocumentMappingChangedException): ApplicationDocumentMigrationNoticeResponse {
        require(change.previous.sourceSha256 == form.attachmentSha256 && change.proposed.sourceSha256 == form.attachmentSha256)
        val token = UUID.randomUUID().toString()
        val proposal = ApplicationDocumentMigrationProposal(ownerId, preparationId, form.formVersionId,
            expectedRevision, form.attachmentSha256, change.previous.pipelineVersion,
            change.previous.mapVersion, change.previous.bindings, change.previous.scopeTargetIds, change.proposed)
        val serialized = json.writeValueAsString(proposal)
        if (serialized.length > 8_000_000) throw ApplicationDocumentException("APPLICATION_DOCUMENT_LIMIT_EXCEEDED", "입력 위치 비교 결과가 제한을 초과했습니다.")
        redis.opsForValue().set(key(ownerId, preparationId, token), serialized, Duration.ofMinutes(15))
        val names = form.sections.flatMap { section -> section.fields.map { field ->
            "${section.key}:${field.key}" to "${section.title} · ${field.label}"
        } }.toMap()
        val changes = change.changes.map { item -> item.toResponse(names, change.previous, change.proposed) }
        return ApplicationDocumentMigrationNoticeResponse(approvalToken = token,
            expectedRevision = expectedRevision, changes = changes)
    }

    fun read(ownerId: Long, preparationId: Long, token: String): ApplicationDocumentMigrationProposal {
        val value = redis.opsForValue().get(key(ownerId, preparationId, token))
            ?: throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE", "입력 위치 확인 요청이 만료되었습니다. 다시 확인해 주세요.")
        val proposal = json.readValue(value, ApplicationDocumentMigrationProposal::class.java)
        if (proposal.ownerId != ownerId || proposal.preparationId != preparationId)
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE", "입력 위치 확인 요청이 일치하지 않습니다.")
        return proposal
    }

    fun discard(ownerId: Long, preparationId: Long, token: String) {
        redis.delete(key(ownerId, preparationId, token))
    }

    private fun key(ownerId: Long, preparationId: Long, token: String) =
        "application-document-migration:$ownerId:$preparationId:$token"

    private fun ApplicationDocumentMappingChange.toResponse(names: Map<String, String>,
            old: ApplicationDocumentMapSnapshot, next: ApplicationDocumentMapSnapshot) =
        ApplicationDocumentMappingChangeResponse(
            fieldLabel = factId?.let { names[it] ?: "확인할 문항" } ?: "문서 편집 범위",
            changeType = type,
            oldLocation = if (type == "SCOPE_CHANGED") "기존 ${oldTargetIds.size}개 입력 위치" else location(old, oldTargetIds),
            newLocation = if (type == "SCOPE_CHANGED") "새 ${newTargetIds.size}개 입력 위치" else location(next, newTargetIds),
        )

    private fun location(snapshot: ApplicationDocumentMapSnapshot, ids: List<String>): String? {
        if (ids.isEmpty()) return null
        val targets = (snapshot.documentMap["targets"] as? List<*>)?.filterIsInstance<Map<*, *>>()
            ?.associateBy { it["targetId"] as? String }.orEmpty()
        return ids.take(3).joinToString(" / ") { id ->
            val target = targets[id].orEmpty()
            val locator = target["nativeLocator"] as? Map<*, *> ?: emptyMap<Any, Any>()
            val labels = (locator["fieldLabels"] as? List<*>)?.filterIsInstance<String>().orEmpty()
            val label = (target["label"] as? String).orEmpty().ifBlank { labels.firstOrNull().orEmpty() }
                .ifBlank { (target["context"] as? String).orEmpty() }.take(90)
            val page = (locator["page"] as? Number)?.toInt()
                ?: ((locator["widgets"] as? List<*>)?.firstOrNull() as? Map<*, *>)?.get("page")?.let { (it as? Number)?.toInt() }
            val parts = mutableListOf<String>()
            if (page != null) parts += "${page + 1}페이지"
            (locator["table"] as? Number)?.let { parts += "표 ${it.toInt()}" }
            (locator["row"] as? Number)?.let { parts += "${it.toInt() + 1}행" }
            (locator["col"] as? Number)?.let { parts += "${it.toInt() + 1}열" }
            (target["kind"] as? String)?.let { parts += it }
            if (label.isNotBlank()) parts += label
            (locator["box"] as? Map<*, *>)?.let { box ->
                val x = (box["x"] as? Number)?.toDouble()
                val y = (box["y"] as? Number)?.toDouble()
                if (x != null && y != null) parts += "왼쪽 ${(x * 100).toInt()}% · 위 ${(y * 100).toInt()}%"
            }
            ((locator["widgets"] as? List<*>)?.firstOrNull() as? Map<*, *>)?.let { widget ->
                val x = (widget["x"] as? Number)?.toDouble()
                val y = (widget["y"] as? Number)?.toDouble()
                if (x != null && y != null) parts += "필드 좌표 ${x.toInt()}, ${y.toInt()}"
            }
            parts.joinToString(" · ").take(180).ifBlank { "위치 정보 확인 필요" }
        } + if (ids.size > 3) " 외 ${ids.size - 3}곳" else ""
    }
}
