package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormAvailabilityDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationFormAvailabilityMapper
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import org.springframework.beans.factory.annotation.Qualifier
import java.time.Clock
import java.time.LocalDateTime
import java.util.UUID

/** 공고별 상태 행이 시스템 Outbox와 실행권을 함께 소유한다. 외부 I/O는 이 Repository 밖에서 수행한다. */
@Repository
class ApplicationFormAvailabilityRepository(
    private val mapper: ApplicationFormAvailabilityMapper,
    private val snapshots: ApplicationFormSnapshotRepository,
    private val timeouts: ai.govbiz.core._common.ai_config.AiServiceClientProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    @Transactional(readOnly = true)
    fun listActiveForms(): List<ApplicationFormManifest> = mapper.listAvailable().flatMap { activeForms(it.sourceCode, it.sourceProgramId) }

    fun find(sourceCode: String, sourceProgramId: String): ApplicationFormAvailability? = mapper.find(sourceCode, sourceProgramId)?.toDomain()

    @Transactional
    fun register(sourceCode: String, sourceProgramId: String, catalogFingerprint: String) {
        mapper.insert(ApplicationFormAvailabilityDbRow(sourceCode=sourceCode, sourceProgramId=sourceProgramId,
            catalogFingerprint=catalogFingerprint, nextRetryAt=now()))
        val row = requireNotNull(mapper.lock(sourceCode, sourceProgramId))
        if (row.catalogFingerprint != catalogFingerprint) {
            row.catalogFingerprint = catalogFingerprint
            invalidate(row, "CATALOG_CHANGED")
            mapper.update(row)
        }
    }

    @Transactional
    fun stale(sourceCode: String, sourceProgramId: String, reason: String) {
        val row = mapper.lock(sourceCode, sourceProgramId) ?: return
        invalidate(row, reason)
        mapper.update(row)
    }

    private fun invalidate(row: ApplicationFormAvailabilityDbRow, reason: String) {
        row.status = "STALE"; row.reasonCode = reason; row.activeFormVersionId = null
        row.generation++; row.leaseToken = null; row.leaseUntil = null
        row.aiStarted = false; row.attemptCount = 0; row.nextRetryAt = now()
    }

    @Transactional
    fun claim(): ApplicationFormAnalysisLease? {
        val row = mapper.nextDue(now()) ?: return null
        // 유료 호출 이후 실행권 유실은 자동 재호출하지 않는다.
        if (row.aiStarted || (row.leaseToken != null && row.attemptCount >= 3)) {
            row.status = "REVIEW_REQUIRED"; row.reasonCode = if (row.aiStarted) "UNKNOWN_AFTER_START" else "WORKER_RETRY_EXHAUSTED"
            row.activeFormVersionId = null; row.nextRetryAt = now().plusDays(1); row.leaseToken = null; row.leaseUntil = null
            row.aiStarted = false; row.lastCompletedStatus = "REVIEW_REQUIRED"; row.lastCompletedReasonCode = row.reasonCode
            row.timeoutStage = "WORKER_EXPIRED"
            row.durationMs = null // 실행 프로세스가 유실되어 실제 소요시간을 측정할 수 없다.
            mapper.update(row)
            return null
        }
        row.attemptCount = if (row.leaseToken == null && row.status in setOf("AVAILABLE", "NO_FORM", "DOCUMENT_UNAVAILABLE", "TOO_LARGE", "REVIEW_REQUIRED")) 1 else row.attemptCount + 1
        row.leaseToken = UUID.randomUUID().toString(); row.leaseUntil = now().plus(timeouts.applicationFormWorkerLease)
        mapper.update(row)
        return ApplicationFormAnalysisLease(row.sourceCode, row.sourceProgramId, row.generation, requireNotNull(row.leaseToken), row.attemptCount)
    }

    /** 명시적인 재분석은 같은 공고의 진행 중 실행권을 빼앗지 않는다. */
    @Transactional
    fun claimRequested(sourceCode: String, sourceProgramId: String): ApplicationFormAnalysisLease? {
        val row = mapper.lock(sourceCode, sourceProgramId) ?: return null
        if (row.leaseToken != null && (row.aiStarted || row.leaseUntil?.isAfter(now()) == true))
            throw ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException(
                ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason.JOB_CONFLICT)
        row.generation++
        row.leaseToken = UUID.randomUUID().toString()
        row.leaseUntil = now().plus(timeouts.applicationFormWorkerLease)
        row.attemptCount = 1
        row.aiStarted = false
        mapper.update(row)
        return ApplicationFormAnalysisLease(sourceCode, sourceProgramId, row.generation, requireNotNull(row.leaseToken), row.attemptCount)
    }

    /** 동일 첨부와 버전에서 완료된 결과는 NO_FORM을 포함하여 재사용한다. */
    @Transactional
    fun observe(lease: ApplicationFormAnalysisLease, metadata: ApplicationFormAnalysisMetadata): Boolean {
        val row = owned(lease)
        val unchanged = row.sourceFingerprint == metadata.sourceFingerprint && row.parserVersion == metadata.parserVersion &&
            row.extractionModel == metadata.configuration.model && row.extractionPromptVersion == metadata.configuration.promptVersion
        if (unchanged && row.lastCompletedStatus in setOf("AVAILABLE", "NO_FORM", "DOCUMENT_UNAVAILABLE", "TOO_LARGE", "REVIEW_REQUIRED")) {
            row.status = requireNotNull(row.lastCompletedStatus)
            row.reasonCode = requireNotNull(row.lastCompletedReasonCode)
            if (row.status == "AVAILABLE") row.activeFormVersionId = snapshots.findByProgram(row.sourceCode, row.sourceProgramId,
                metadata.sourceFingerprint, metadata.parserVersion, metadata.configuration.model, metadata.configuration.promptVersion).first().formVersionId
            row.durationMs = (System.nanoTime() - lease.startedNanos) / 1_000_000; row.timeoutStage = null
            release(row); row.nextRetryAt = now().plusDays(1); row.verifiedAt = now(); mapper.update(row)
            return false
        }
        if (!unchanged) {
            if (row.sourceFingerprint != null) {
                row.status = "STALE"; row.reasonCode = "SOURCE_OR_VERSION_CHANGED"; row.activeFormVersionId = null
            }
            row.attemptCount = 1; row.lastCompletedStatus = null; row.lastCompletedReasonCode = null
        }
        row.sourceFingerprint = metadata.sourceFingerprint; row.parserVersion = metadata.parserVersion
        row.extractionModel = metadata.configuration.model; row.extractionPromptVersion = metadata.configuration.promptVersion
        mapper.update(row)
        return true
    }

    @Transactional
    fun beforeAi(lease: ApplicationFormAnalysisLease) {
        val row = owned(lease)
        check(!row.aiStarted)
        row.aiStarted = true
        mapper.update(row)
    }

    /** 스냅샷 저장과 활성 포인터 전환은 반드시 같은 짧은 transaction에서 수행한다. */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    fun available(lease: ApplicationFormAnalysisLease, forms: List<ApplicationFormManifest>, metadata: ApplicationFormAnalysisMetadata, importHash: String? = null) {
        val row = owned(lease)
        require(forms.isNotEmpty() && forms.all { it.sourceCode == lease.sourceCode && it.sourceProgramId == lease.sourceProgramId })
        snapshots.save(forms, metadata.sourceFingerprint, metadata.parserVersion, metadata.configuration)
        row.lastCompletedReasonCode = "FORM_FOUND"; row.lastCompletedStatus = "AVAILABLE"; row.durationMs = (System.nanoTime() - lease.startedNanos) / 1_000_000; row.timeoutStage = null
        row.status = "AVAILABLE"; row.reasonCode = "FORM_FOUND"; row.activeFormVersionId = forms.first().formVersionId
        row.sourceFingerprint = metadata.sourceFingerprint; row.parserVersion = metadata.parserVersion
        row.extractionModel = metadata.configuration.model; row.extractionPromptVersion = metadata.configuration.promptVersion
        row.verifiedAt = now(); row.nextRetryAt = now().plusDays(1); row.importSha256 = importHash
        release(row); mapper.update(row)
        org.slf4j.LoggerFactory.getLogger(javaClass).info("application_form_analysis sourceCode={} sourceProgramId={} status={} reasonCode={} durationMs={} timeoutStage={}",
            row.sourceCode, row.sourceProgramId, row.status, row.reasonCode, row.durationMs, row.timeoutStage)
    }

    @Transactional
    fun finish(lease: ApplicationFormAnalysisLease, status: ApplicationFormAvailabilityStatus, reason: String, retryable: Boolean = false, importHash: String? = null, timeoutStage: String? = null, cacheResult: Boolean = true, failureConfiguration: ApplicationFormDiscoveryConfiguration? = null) {
        val row = owned(lease)
        row.durationMs = (System.nanoTime() - lease.startedNanos) / 1_000_000; row.timeoutStage = timeoutStage
        if (row.sourceFingerprint == null && failureConfiguration != null) {
            row.parserVersion = ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser.VERSION
            row.extractionModel = failureConfiguration.model; row.extractionPromptVersion = failureConfiguration.promptVersion
        }
        require(status != ApplicationFormAvailabilityStatus.AVAILABLE)
        row.status = if (retryable && row.attemptCount >= 3) "REVIEW_REQUIRED" else status.name
        row.reasonCode = if (retryable && row.attemptCount >= 3) "RETRY_EXHAUSTED:$reason" else reason
        if (cacheResult && row.status in setOf("NO_FORM", "DOCUMENT_UNAVAILABLE", "TOO_LARGE", "REVIEW_REQUIRED")) { row.lastCompletedStatus = row.status; row.lastCompletedReasonCode = row.reasonCode }
        row.activeFormVersionId = null; row.verifiedAt = now(); row.importSha256 = importHash
        row.nextRetryAt = when {
            retryable && row.attemptCount < 3 -> now().plusMinutes(if (row.attemptCount == 1) 5 else 30)
            status == ApplicationFormAvailabilityStatus.STALE || status == ApplicationFormAvailabilityStatus.PENDING -> now()
            row.status in setOf("NO_FORM", "DOCUMENT_UNAVAILABLE", "TOO_LARGE", "REVIEW_REQUIRED") -> now().plusDays(1)
            else -> null
        }
        release(row); mapper.update(row)
        org.slf4j.LoggerFactory.getLogger(javaClass).info("application_form_analysis sourceCode={} sourceProgramId={} status={} reasonCode={} durationMs={} timeoutStage={}",
            row.sourceCode, row.sourceProgramId, row.status, row.reasonCode, row.durationMs, row.timeoutStage)
    }

    @Transactional
    fun requireActive(sourceCode: String, sourceProgramId: String, version: String): ApplicationFormManifest {
        val row = mapper.lock(sourceCode, sourceProgramId)
        if (row?.status != "AVAILABLE") throw ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormNotSupportedException()
        return activeForms(sourceCode, sourceProgramId).find { it.formVersionId == version }
            ?: throw ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormNotSupportedException()
    }

    @Transactional(readOnly = true)
    fun activeForms(sourceCode: String, sourceProgramId: String): List<ApplicationFormManifest> {
        val row = mapper.find(sourceCode, sourceProgramId) ?: return emptyList()
        if (row.status != "AVAILABLE") return emptyList()
        val forms = snapshots.findByProgram(sourceCode, sourceProgramId, requireNotNull(row.sourceFingerprint),
            requireNotNull(row.parserVersion), requireNotNull(row.extractionModel), requireNotNull(row.extractionPromptVersion))
        check(forms.any { it.formVersionId == row.activeFormVersionId }) { "Active application form snapshot is missing" }
        return forms
    }

    /** 명시적으로 실행한 importer만 사용한다. 기존 분석 또는 더 최신 결과를 덮어쓰지 않는다. */
    @Transactional
    fun claimImport(sourceCode: String, sourceProgramId: String, fileHash: String, catalogFingerprint: String): ApplicationFormAnalysisLease? {
        mapper.insert(ApplicationFormAvailabilityDbRow(sourceCode=sourceCode, sourceProgramId=sourceProgramId, catalogFingerprint=catalogFingerprint))
        val row = requireNotNull(mapper.lock(sourceCode, sourceProgramId))
        if (row.importSha256 == fileHash || row.verifiedAt != null || (row.leaseToken != null && (row.aiStarted || row.leaseUntil?.isAfter(now()) == true))) return null
        row.leaseToken = UUID.randomUUID().toString(); row.leaseUntil = now().plus(timeouts.applicationFormWorkerLease); row.attemptCount++
        mapper.update(row)
        return ApplicationFormAnalysisLease(sourceCode, sourceProgramId, row.generation, requireNotNull(row.leaseToken), row.attemptCount)
    }

    private fun owned(lease: ApplicationFormAnalysisLease): ApplicationFormAvailabilityDbRow =
        requireNotNull(mapper.lock(lease.sourceCode, lease.sourceProgramId)).also {
            check(it.generation == lease.generation && it.leaseToken == lease.token && requireNotNull(it.leaseUntil).isAfter(now())) { "Application form analysis lease lost" }
        }
    private fun release(row: ApplicationFormAvailabilityDbRow) { row.leaseToken = null; row.leaseUntil = null; row.aiStarted = false }
    private fun now() = LocalDateTime.now(clock)
    private fun ApplicationFormAvailabilityDbRow.toDomain() = ApplicationFormAvailability(sourceCode, sourceProgramId,
        ApplicationFormAvailabilityStatus.valueOf(status), reasonCode, sourceFingerprint, parserVersion, extractionModel,
        extractionPromptVersion, activeFormVersionId, verifiedAt, nextRetryAt, attemptCount, durationMs, timeoutStage)
}
