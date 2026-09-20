package ai.govbiz.catalog.supportprogram.service.sync

import ai.govbiz.catalog._common.exception.AiServiceCallException
import ai.govbiz.catalog.supportprogram.client.ai.AiSupportProgramIndexClient
import ai.govbiz.catalog.supportprogram.client.ai.dto.AiSupportProgramIndexBatchRequest
import ai.govbiz.catalog.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.catalog.supportprogram.client.elasticsearch.ElasticsearchSupportProgramClient
import ai.govbiz.catalog.supportprogram.client.elasticsearch.mapper.ElasticsearchSupportProgramDocumentMapper
import ai.govbiz.catalog.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.catalog.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.catalog.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import org.springframework.stereotype.Service

/** 공개 전 키워드·벡터 색인을 준비하고, 현재 공고의 누락 색인을 복구합니다. */
@Service
class SupportProgramIndexSyncService(
    private val repository: SupportProgramRepository,
    private val client: AiSupportProgramIndexClient,
    private val lexicalClient: ElasticsearchSupportProgramClient,
) {
    /**
     * 이미 MySQL에 공개된 공고의 키워드·벡터 색인을 복구합니다.
     *
     * 이 작업은 삭제를 수행하지 않습니다. 새 카탈로그의 벡터를 준비하는 도중 이전 스냅샷 기준의
     * 정리 작업이 새 벡터를 삭제하지 않게 하기 위해서입니다.
     */
    fun repair(): Int {
        val programs = repository.findPresent()
        val statuses = repository.findSyncStatuses().associateBy { it.sourceCode }
        check(programs.size <= SupportProgramIndexDocumentMapper.MAX_DOCUMENTS) { "index catalog exceeds supported limit" }
        val programsBySource = programs.groupBy { it.program.sourceCode }
        var indexedCount = 0
        var firstFailure: RuntimeException? = null

        // 공개 공고가 0개인 성공 스냅샷도 상태 행을 기준으로 복구합니다.
        for (sourceCode in programsBySource.keys + statuses.keys) {
            val sourcePrograms = programsBySource[sourceCode].orEmpty()
            val status = statuses[sourceCode]
            var repairTarget: SourceRepairTarget? = null
            try {
                repairTarget = repairTargetFor(sourceCode, sourcePrograms, status)
                val needsLegacyBootstrap =
                    repairTarget == null && status?.publishedCatalogFingerprint == null && sourcePrograms.isNotEmpty()
                indexedCount += indexSnapshot(sourcePrograms)
                if (repairTarget != null) {
                    repairTarget.markReady()
                } else if (needsLegacyBootstrap) {
                    repository.bootstrapLegacySnapshotAfterSuccessfulRepair(sourceCode, sourcePrograms)
                }
            } catch (exception: RuntimeException) {
                try {
                    repairTarget?.markNotReady()
                } catch (statusRecordingException: RuntimeException) {
                    if (statusRecordingException !== exception) exception.addSuppressed(statusRecordingException)
                }
                val previousFailure = firstFailure
                if (previousFailure == null) {
                    firstFailure = exception
                } else if (previousFailure !== exception) {
                    previousFailure.addSuppressed(exception)
                }
            }
        }
        firstFailure?.let { throw it }
        return indexedCount
    }

    /**
     * MySQL에 공개하기 전 카탈로그 스냅샷의 현재 버전을 색인합니다.
     *
     * 모든 batch가 성공할 때만 호출자에게 반환하므로, 호출자는 이 메서드가 성공한 뒤에만 해당
     * 스냅샷을 DB에 공개할 수 있습니다.
     */
    fun indexSnapshot(programs: List<CatalogSupportProgram>): Int {
        check(programs.size <= SupportProgramIndexDocumentMapper.MAX_DOCUMENTS) { "index catalog exceeds supported limit" }
        val documents = programs.map(SupportProgramIndexDocumentMapper::fromCatalog)
        check(documents.map { it.id }.toSet().size == documents.size) { "duplicate catalog identities" }
        lexicalClient.indexSnapshot(programs.map(ElasticsearchSupportProgramDocumentMapper::fromCatalog))
        // 외부 API는 DB transaction 밖에서 호출하며, 같은 문서 버전은 AI Service가 재사용합니다.
        for (batch in documents.chunked(BATCH_SIZE)) {
            val result = client.indexBatch(AiSupportProgramIndexBatchRequest(batch))
            if (result.indexedCount != batch.size) {
                throw AiServiceCallException.invalidResponse("AI Service did not acknowledge every index document", null)
            }
        }
        return documents.size
    }

    private fun repairTargetFor(
        sourceCode: String,
        programs: List<CatalogSupportProgram>,
        status: SupportProgramSyncStatus?,
    ): SourceRepairTarget? {
        status ?: return null
        val publishedGeneration = status.publishedGeneration ?: return null
        val publishedFingerprint = status.publishedCatalogFingerprint ?: return null
        if (programs.size != status.publishedProgramCount) return null
        if (SupportProgramCatalogFingerprintHelper.calculate(programs) != publishedFingerprint) return null

        return SourceRepairTarget(
            sourceCode = sourceCode,
            publishedGeneration = publishedGeneration,
            catalogFingerprint = publishedFingerprint,
            programCount = programs.size,
        )
    }

    private inner class SourceRepairTarget(
        private val sourceCode: String,
        private val publishedGeneration: Long,
        private val catalogFingerprint: String,
        private val programCount: Int,
    ) {
        fun markReady() {
            repository.markIndexReadyIfPublishedSnapshotMatches(
                sourceCode = sourceCode,
                publishedGeneration = publishedGeneration,
                expectedCatalogFingerprint = catalogFingerprint,
                expectedProgramCount = programCount,
            )
        }

        fun markNotReady() {
            repository.markIndexNotReadyIfPublishedSnapshotMatches(
                sourceCode = sourceCode,
                publishedGeneration = publishedGeneration,
                expectedCatalogFingerprint = catalogFingerprint,
                expectedProgramCount = programCount,
            )
        }
    }

    private companion object {
        const val BATCH_SIZE = 16
    }
}
