package ai.govbiz.core.supportprogram.repository

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.repository.mapper.SupportProgramDbRow
import ai.govbiz.core.supportprogram.repository.mapper.SupportProgramMapper
import ai.govbiz.core.supportprogram.repository.mapper.SupportProgramSourceDocumentDbRow
import ai.govbiz.core.supportprogram.repository.mapper.SupportProgramSyncStatusDbRow
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.core.type.TypeReference
import tools.jackson.databind.ObjectMapper

/** 외부 제공처에서 정규화한 지원사업 카탈로그를 MySQL에 저장하고 읽습니다. */
@Repository
class SupportProgramRepository(
    private val supportProgramMapper: SupportProgramMapper,
    private val objectMapper: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {

    @Transactional
    fun upsert(catalogProgram: CatalogSupportProgram) {
        requireSourceCode(catalogProgram.program.sourceCode)
        supportProgramMapper.upsert(catalogProgram.toDbRow())
    }

    /** 제공처의 완전한 최신 목록으로 해당 제공처 데이터의 노출 상태와 내용을 원자적으로 갱신합니다. */
    @Transactional
    fun synchronizeSource(sourceCode: String, programs: List<CatalogSupportProgram>) {
        requireSourcePrograms(sourceCode, programs)
        replaceSourceSnapshot(sourceCode, programs)
    }

    /**
     * 새 동기화 실행에 단조 증가하는 세대를 부여합니다.
     *
     * 외부 API와 AI 호출은 이 짧은 DB transaction 뒤에서 수행합니다. 이후 먼저 시작한 실행이 늦게
     * 끝나더라도 최신 세대만 카탈로그를 공개하게 합니다.
     */
    @Transactional
    fun startSyncGeneration(sourceCode: String): Long {
        requireSourceCode(sourceCode)
        supportProgramMapper.insertSyncGenerationIfAbsent(sourceCode)
        val currentGeneration = requireNotNull(
            supportProgramMapper.lockLatestStartedGeneration(sourceCode),
        ) { "$sourceCode sync generation row was not created" }
        check(currentGeneration < Long.MAX_VALUE) { "$sourceCode sync generation overflow" }
        val nextGeneration = currentGeneration + 1
        check(
            supportProgramMapper.updateLatestStartedGeneration(sourceCode, nextGeneration) == 1,
        ) { "$sourceCode sync generation was not updated" }
        supportProgramMapper.insertSyncStatusIfAbsent(sourceCode)
        return nextGeneration
    }

    /**
     * 현재 실행 세대가 가장 최근에 시작된 경우에만 완성된 공고 스냅샷을 공개합니다.
     *
     * 행 잠금과 카탈로그 교체를 같은 짧은 transaction으로 묶어, 늦게 끝난 이전 수집 결과가
     * 더 최신 실행의 결과를 덮어쓰지 못하게 합니다.
     */
    @Transactional
    fun publishSnapshotIfCurrent(
        sourceCode: String,
        programs: List<CatalogSupportProgram>,
        generation: Long,
    ): Boolean {
        requireSourcePrograms(sourceCode, programs)
        val latestGeneration = requireNotNull(
            supportProgramMapper.lockLatestStartedGeneration(sourceCode),
        ) { "$sourceCode sync generation row does not exist" }
        if (latestGeneration != generation) return false

        replaceSourceSnapshot(sourceCode, programs)
        supportProgramMapper.upsertSyncSuccess(
            sourceCode = sourceCode,
            generation = generation,
            catalogFingerprint = SupportProgramCatalogFingerprintHelper.calculate(programs),
            programCount = programs.size,
            occurredAt = LocalDateTime.now(clock),
        )
        return true
    }

    /** 색인 복구가 읽은 공개 스냅샷과 상태 행이 아직 같을 때만 준비 완료를 기록합니다. */
    @Transactional
    fun markIndexReadyIfPublishedSnapshotMatches(
        sourceCode: String,
        publishedGeneration: Long,
        expectedCatalogFingerprint: String,
        expectedProgramCount: Int,
    ): Boolean {
        requireSourceCode(sourceCode)
        return supportProgramMapper.markSyncIndexReady(
            sourceCode = sourceCode,
            publishedGeneration = publishedGeneration,
            catalogFingerprint = expectedCatalogFingerprint,
            programCount = expectedProgramCount,
        ) == 1
    }

    /** 색인 복구가 읽은 공개 스냅샷과 상태 행이 아직 같을 때만 준비 실패를 기록합니다. */
    @Transactional
    fun markIndexNotReadyIfPublishedSnapshotMatches(
        sourceCode: String,
        publishedGeneration: Long,
        expectedCatalogFingerprint: String,
        expectedProgramCount: Int,
    ): Boolean {
        requireSourceCode(sourceCode)
        return supportProgramMapper.markSyncIndexNotReady(
            sourceCode = sourceCode,
            publishedGeneration = publishedGeneration,
            catalogFingerprint = expectedCatalogFingerprint,
            programCount = expectedProgramCount,
        ) == 1
    }

    /**
     * V4 상태 행이 없던 기존 공개 공고를 전체 색인 복구가 성공한 뒤에만 신뢰 가능한 준비 상태로 채택합니다.
     *
     * 실제 공개 세대를 복원할 수 없으므로 sentinel 세대 0을 사용합니다. 이미 지문이 있는 새 스냅샷은
     * SQL의 조건부 갱신으로 절대 바꾸지 않습니다.
     */
    @Transactional
    fun bootstrapLegacySnapshotAfterSuccessfulRepair(
        sourceCode: String,
        programs: List<CatalogSupportProgram>,
    ): Boolean {
        requireSourcePrograms(sourceCode, programs)
        if (programs.isEmpty()) return false

        supportProgramMapper.insertSyncStatusIfAbsent(sourceCode)
        return supportProgramMapper.bootstrapSyncStatusIfUntrusted(
            sourceCode = sourceCode,
            catalogFingerprint = SupportProgramCatalogFingerprintHelper.calculate(programs),
            programCount = programs.size,
        ) > 0
    }

    /** 현재 세대의 수집 또는 필수 색인 실패만 기록하고, 이전 공개 카탈로그는 변경하지 않습니다. */
    @Transactional
    fun recordSyncFailureIfCurrent(sourceCode: String, generation: Long): Boolean {
        requireSourceCode(sourceCode)
        val latestGeneration = requireNotNull(
            supportProgramMapper.lockLatestStartedGeneration(sourceCode),
        ) { "$sourceCode sync generation row does not exist" }
        if (latestGeneration != generation) return false

        supportProgramMapper.upsertSyncFailure(
            sourceCode = sourceCode,
            occurredAt = LocalDateTime.now(clock),
        )
        return true
    }

    /** 현재 노출 중인 공고를 제공처 코드와 제공처 원본 ID 조합으로 조회합니다. */
    fun findPresentBySourceAndProgramId(
        sourceCode: String,
        sourceProgramId: String,
    ): CatalogSupportProgram? {
        requireSourceCode(sourceCode)
        return supportProgramMapper.findBySourceAndProgramId(sourceCode, sourceProgramId)
            ?.toCatalogProgram()
    }

    /** 색인 복구를 위해 준비 상태와 무관하게 모든 제공처의 현재 공고를 반환합니다. */
    fun findPresent(): List<CatalogSupportProgram> =
        java.util.List.copyOf(
            supportProgramMapper
                .findPresent()
                .map { it.toCatalogProgram() },
        )

    /** 색인이 준비된 제공처의 현재 공고만 하나의 DB 조회로 검색 후보에 포함합니다. */
    fun findSearchablePresent(): List<CatalogSupportProgram> =
        java.util.List.copyOf(
            supportProgramMapper.findPublishedPresent(requireIndexReady = true).map { it.toCatalogProgram() },
        )

    /** 이미 공개된 DB 스냅샷의 최신 목록은 이후 색인 장애와 무관하게 읽을 수 있습니다. */
    fun findPublishedPresent(): List<CatalogSupportProgram> =
        java.util.List.copyOf(
            supportProgramMapper.findPublishedPresent(requireIndexReady = false).map { it.toCatalogProgram() },
        )

    /** 해당 제공처의 동기화 또는 기존 공고 색인 복구가 아직 시작되지 않았으면 null을 반환합니다. */
    fun findSyncStatus(sourceCode: String): SupportProgramSyncStatus? {
        requireSourceCode(sourceCode)
        return supportProgramMapper.findSyncStatus(sourceCode)?.toSyncStatus()
    }

    /** 저장된 동기화 상태와 상태 행 없이 기존 공고만 남아 있는 제공처의 미확인 상태를 반환합니다. */
    fun findSyncStatuses(): List<SupportProgramSyncStatus> =
        java.util.List.copyOf(supportProgramMapper.findSyncStatuses().map { it.toSyncStatus() })

    /** 현재 공개된 공고에 연결된 공식 원문 근거 문서를 조회합니다. */
    fun findPresentSourceDocument(
        sourceCode: String,
        sourceProgramId: String,
    ): SupportProgramSourceDocument? {
        requireSourceCode(sourceCode)
        return supportProgramMapper
            .findPresentSourceDocument(sourceCode, sourceProgramId)
            ?.toSourceDocument()
    }

    /** 외부 호출을 끝낸 뒤 짧은 DB transaction으로 공식 원문 근거 문서를 저장합니다. */
    @Transactional
    fun upsertSourceDocument(document: SupportProgramSourceDocument) {
        requireSourceCode(document.sourceCode)
        supportProgramMapper.upsertSourceDocument(document.toDbRow())
    }

    private fun CatalogSupportProgram.toDbRow(): SupportProgramDbRow {
        val supportProgram = program

        return SupportProgramDbRow(
            sourceCode = supportProgram.sourceCode,
            sourceProgramId = supportProgram.id,
            title = supportProgram.title,
            organization = supportProgram.organization,
            summary = supportProgram.summary,
            categoriesJson = objectMapper.writeValueAsString(supportProgram.categories),
            regionsJson = objectMapper.writeValueAsString(supportProgram.regions),
            targetDescription = supportProgram.targetDescription,
            applicationPeriodRaw = supportProgram.applicationPeriod,
            applicationStartDate = supportProgram.applicationStartDate,
            applicationEndDate = supportProgram.applicationEndDate,
            sourceUrl = supportProgram.sourceUrl,
            sourceSortTimestamp = sortTimestamp.takeIf(String::isNotBlank),
            startupDetailsJson = startupDetails?.let(objectMapper::writeValueAsString),
        )
    }

    /** 관심 공고함처럼 공고 행을 함께 읽는 다른 Repository가 같은 변환을 쓸 때 부릅니다. */
    internal fun toProgram(row: SupportProgramDbRow): SupportProgram = row.toCatalogProgram().program

    private fun SupportProgramDbRow.toCatalogProgram(): CatalogSupportProgram {
        val period = applicationPeriodRaw
        val startDate = applicationStartDate
        val endDate = applicationEndDate

        return CatalogSupportProgram(
            program = SupportProgram(
                id = sourceProgramId,
                sourceCode = sourceCode,
                title = title,
                organization = organization,
                summary = summary,
                categories = readStringList(categoriesJson),
                regions = readStringList(regionsJson),
                targetDescription = targetDescription,
                applicationPeriod = period,
                applicationStartDate = startDate,
                applicationEndDate = endDate,
                status = SupportProgramStatusResolver.resolve(
                    applicationPeriod = period,
                    applicationStartDate = startDate,
                    applicationEndDate = endDate,
                    today = LocalDate.now(clock),
                ),
                sourceName = sourceNameFor(sourceCode),
                sourceUrl = sourceUrl,
                matchedReasons = emptyList(),
                recommendationScore = null,
            ),
            sortTimestamp = sourceSortTimestamp.orEmpty(),
            startupDetails = startupDetailsJson?.let {
                objectMapper.readValue(it, SupportProgramStartupDetails::class.java)
            },
        )
    }

    private fun SupportProgramSourceDocument.toDbRow(): SupportProgramSourceDocumentDbRow =
        SupportProgramSourceDocumentDbRow(
            sourceCode = sourceCode,
            sourceProgramId = sourceProgramId,
            sourceUrl = sourceUrl,
            content = content,
            contentHash = contentHash,
            fetchedAt = fetchedAt,
        )

    private fun SupportProgramSourceDocumentDbRow.toSourceDocument(): SupportProgramSourceDocument =
        SupportProgramSourceDocument(
            sourceCode = sourceCode,
            sourceProgramId = sourceProgramId,
            sourceUrl = sourceUrl,
            content = content,
            contentHash = contentHash,
            fetchedAt = requireNotNull(fetchedAt) { "source document fetchedAt must not be null" },
        )

    private fun SupportProgramSyncStatusDbRow.toSyncStatus(): SupportProgramSyncStatus =
        SupportProgramSyncStatus(
            sourceCode = sourceCode,
            publishedGeneration = publishedGeneration,
            publishedCatalogFingerprint = publishedCatalogFingerprint,
            publishedProgramCount = publishedProgramCount,
            indexReady = indexReady,
            lastSuccessfulSyncAt = lastSuccessfulSyncAt,
            lastFailedSyncAt = lastFailedSyncAt,
            lastSyncOutcome = SupportProgramSyncOutcome.valueOf(lastSyncOutcome),
        )

    private fun readStringList(value: String): List<String> =
        java.util.List.copyOf(objectMapper.readValue(value, STRING_LIST_TYPE))

    private fun sourceNameFor(sourceCode: String): String =
        when (sourceCode) {
            "BIZINFO" -> "기업마당"
            "KSTARTUP" -> "K-Startup"
            "MSIT" -> "과학기술정보통신부"
            "CNTRADE_NOTICE" -> "충청남도 온라인수출지원시스템"
            else -> sourceCode
        }

    private fun requireSourceCode(sourceCode: String) {
        require(SOURCE_CODE_PATTERN.matches(sourceCode)) {
            "sourceCode must match [A-Z][A-Z0-9_]{0,63}"
        }
    }

    private fun requireSourcePrograms(sourceCode: String, programs: List<CatalogSupportProgram>) {
        requireSourceCode(sourceCode)
        require(programs.all { it.program.sourceCode == sourceCode }) {
            "$sourceCode synchronization accepts only matching source programs"
        }
    }

    private fun replaceSourceSnapshot(sourceCode: String, programs: List<CatalogSupportProgram>) {
        supportProgramMapper.markAllNotPresentBySourceCode(sourceCode)
        // 입력 순서와 transaction을 유지하면서 DB 왕복과 임시 행 목록의 크기를 제한합니다.
        programs.asSequence().chunked(UPSERT_BATCH_SIZE).forEach { batch ->
            supportProgramMapper.upsertBatch(batch.map { it.toDbRow() })
        }
    }

    private companion object {
        const val UPSERT_BATCH_SIZE = 100
        val SOURCE_CODE_PATTERN = Regex("[A-Z][A-Z0-9_]{0,63}")
        val STRING_LIST_TYPE = object : TypeReference<List<String>>() {}
    }
}
