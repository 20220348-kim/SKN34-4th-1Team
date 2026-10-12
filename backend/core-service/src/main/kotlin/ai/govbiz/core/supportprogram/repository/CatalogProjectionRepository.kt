package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import ai.govbiz.core.supportprogram.domain.CatalogProjectionSnapshot
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.repository.mapper.CatalogProjectionCheckpointDbRow
import ai.govbiz.core.supportprogram.repository.mapper.CatalogProjectionMapper
import ai.govbiz.core.supportprogram.repository.mapper.SupportProgramSyncStatusDbRow
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.node.ObjectNode

/** 검증된 Catalog snapshot을 기존 공고 FK와 신청서 분석 상태를 보존하며 원자적으로 반영합니다. */
@Repository
class CatalogProjectionRepository(
    private val mapper: CatalogProjectionMapper,
    private val programs: SupportProgramRepository,
    private val availability: ApplicationFormAvailabilityRepository,
    private val objectMapper: ObjectMapper,
) {
    fun hasCheckpoints(): Boolean = mapper.countCheckpoints() > 0

    /** HTTP 수신과 페이지 수집은 호출 전에 끝나야 합니다. 이전 revision은 기존 상태를 바꾸지 않습니다. */
    @Transactional
    fun apply(snapshot: CatalogProjectionSnapshot): Boolean {
        validate(snapshot)
        val sourceCode = snapshot.status.sourceCode
        val catalogId = UUID.fromString(snapshot.catalogId).toString()
        val generation = requireNotNull(snapshot.status.publishedGeneration)
        val programsHash = programsHash(snapshot.programs)
        val payloadHash = hash(listOf(snapshot.status, programsHash))

        // V1의 자연키는 대소문자·악센트를 구분하지 않습니다. DB와 동일한 비교로 중복을 거부합니다.
        require(mapper.countDistinctProgramIds(objectMapper.writeValueAsString(snapshot.programs.map { it.program.id })) == snapshot.programs.size) {
            "Catalog snapshot contains program identities that collide in MySQL"
        }
        mapper.insertCheckpointIfAbsent(CatalogProjectionCheckpointDbRow(sourceCode, catalogId, 0, 0, "0".repeat(64), "0".repeat(64)))
        val previous = requireNotNull(mapper.lockCheckpoint(sourceCode)) { "Catalog projection checkpoint was not created" }
        check(previous.catalogId == catalogId) { "Catalog instance changed; explicit projection reseeding is required" }
        if (snapshot.revision < previous.revision) return false
        if (snapshot.revision == previous.revision) {
            check(previous.payloadHash == payloadHash) { "Catalog changed a previously applied revision" }
            return false
        }
        check(generation >= previous.publishedGeneration) { "Catalog published generation moved backwards" }
        check(previous.revision == 0L || generation > previous.publishedGeneration || previous.programsHash == programsHash) {
            "Catalog changed programs without publishing a new generation"
        }

        // synchronizeSource uses UPSERT, keeping local numeric IDs and saved/partner foreign keys intact.
        programs.synchronizeSource(sourceCode, snapshot.programs)
        val status = snapshot.status
        mapper.upsertSyncStatus(SupportProgramSyncStatusDbRow(
            sourceCode = sourceCode,
            publishedGeneration = generation,
            publishedCatalogFingerprint = status.publishedCatalogFingerprint,
            publishedProgramCount = status.publishedProgramCount,
            indexReady = status.indexReady,
            lastSuccessfulSyncAt = status.lastSuccessfulSyncAt,
            lastFailedSyncAt = status.lastFailedSyncAt,
            lastSyncOutcome = status.lastSyncOutcome.name,
        ))
        snapshot.programs.forEach { item ->
            availability.register(sourceCode, item.program.id, SupportProgramCatalogFingerprintHelper.calculate(listOf(item)))
        }
        check(mapper.updateCheckpoint(CatalogProjectionCheckpointDbRow(sourceCode, catalogId, snapshot.revision, generation, payloadHash, programsHash)) == 1) {
            "Catalog projection checkpoint was not updated"
        }
        return true
    }

    private fun validate(snapshot: CatalogProjectionSnapshot) {
        require(UUID.fromString(snapshot.catalogId).toString().equals(snapshot.catalogId, ignoreCase = true)) {
            "catalogId must be a canonical UUID"
        }
        require(snapshot.revision > 0) { "Catalog revision must be positive" }
        val status = snapshot.status
        require(status.sourceCode in SOURCES) { "Unsupported Catalog source" }
        require(status.publishedGeneration != null && status.publishedGeneration >= 0) { "Catalog snapshot is not published" }
        require(status.publishedCatalogFingerprint?.matches(FINGERPRINT) == true) { "Invalid published Catalog fingerprint" }
        require(snapshot.programs.size <= MAX_PROGRAMS && status.publishedProgramCount == snapshot.programs.size) {
            "Catalog snapshot count is incomplete or exceeds the supported limit"
        }
        require(snapshot.programs.all { it.program.sourceCode == status.sourceCode }) { "Catalog snapshot contains another source" }
        require(snapshot.programs.map { it.program.id }.toSet().size == snapshot.programs.size) { "Duplicate Catalog program identities" }
        require(snapshot.programs.all { it.startupDetails == null || it.program.sourceCode == "KSTARTUP" }) {
            "Startup metadata belongs only to KSTARTUP"
        }
        require(SupportProgramCatalogFingerprintHelper.calculate(snapshot.programs) == status.publishedCatalogFingerprint) {
            "Catalog snapshot fingerprint does not match the published snapshot"
        }
    }

    private fun programsHash(items: List<CatalogSupportProgram>): String {
        // Date-derived status and response enrichments are not stored columns and may change without a new revision.
        // Hash every stored column (including dates, URLs and sort order not covered by the search fingerprint).
        val persistedPrograms: List<CatalogSupportProgram> = items.sortedBy { it.program.id }.map { item ->
            item.copy(program = item.program.copy(
                status = SupportProgramStatus.UNKNOWN,
                sourceName = "",
                matchedReasons = emptyList(),
                recommendationScore = null,
                eligibilityReview = null,
            ), sortTimestamp = item.sortTimestamp.takeIf(String::isNotBlank).orEmpty())
        }
        // 검색 응답에만 붙는 필드는 키째 지워 그 필드가 없던 때와 같은 바이트로 셉니다. 남겨 두면 필드를 추가한 배포마다
        // 이미 반영한 revision이 바뀐 것으로 보여 Catalog 반영이 멈춥니다(저장 열을 바꾼 경우만 V51처럼 checkpoint를 초기화).
        val tree = objectMapper.valueToTree<JsonNode>(persistedPrograms)
        tree.forEach { (it.get("program") as ObjectNode).remove(RESPONSE_ONLY_PROGRAM_FIELDS) }
        return hash(tree)
    }

    private fun hash(value: Any): String = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
        .digest(objectMapper.writeValueAsBytes(value)))

    private companion object {
        const val MAX_PROGRAMS = 20_000
        val SOURCES = setOf("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
        val FINGERPRINT = Regex("[0-9a-f]{64}")
        /** [ai.govbiz.core.supportprogram.domain.SupportProgram]의 검색 결과 전용 필드입니다. 저장 열이 아닙니다. */
        val RESPONSE_ONLY_PROGRAM_FIELDS = listOf("regionTagMismatch", "alsoPostedBy")
    }
}
