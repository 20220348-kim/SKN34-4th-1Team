package ai.govbiz.core.supportprogram.service.readiness

import ai.govbiz.core.supportprogram.domain.SupportProgramSyncOutcome
import ai.govbiz.core.supportprogram.domain.SupportProgramSyncStatus
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchReadinessResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchState
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSourceReadinessResult
import java.time.Clock
import java.time.LocalDateTime
import java.time.OffsetDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service

/** 제공처별 공개 스냅샷의 상태를 모아 현재 검색 가능한 범위를 안내합니다. */
@Service
class SupportProgramSearchReadinessService(
    private val repository: SupportProgramRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
    @param:Value("\${app.kstartup.sync.enabled:false}") private val kStartupEnabled: Boolean = false,
    @param:Value("\${app.msit.sync.enabled:false}") private val msitEnabled: Boolean = false,
    @param:Value("\${app.cntrade-notice.sync.enabled:false}") private val cnTradeNoticeEnabled: Boolean = false,
) {
    fun get(): SupportProgramSearchReadinessResult {
        val statuses = repository.findSyncStatuses().associateBy { it.sourceCode }
        // 활성화된 수집기는 첫 실행 전에도 표시하고, 중지한 제공처의 저장된 상태도 보존합니다.
        val configuredSources = buildSet {
            add("BIZINFO")
            if (kStartupEnabled) add("KSTARTUP")
            if (msitEnabled) add("MSIT")
            if (cnTradeNoticeEnabled) add("CNTRADE_NOTICE")
        }
        val sources = (statuses.keys + configuredSources).sorted().map { sourceCode ->
            val status = statuses[sourceCode]
            SupportProgramSourceReadinessResult(
                sourceCode = sourceCode,
                sourceName = when (sourceCode) {
                    "BIZINFO" -> "기업마당"
                    "KSTARTUP" -> "K-Startup"
                    "MSIT" -> "과학기술정보통신부"
                    "CNTRADE_NOTICE" -> "충청남도 온라인수출지원시스템"
                    else -> sourceCode
                },
                searchState = stateFor(status),
                programCount = status?.publishedProgramCount ?: 0,
                indexReady = status?.indexReady == true,
                lastSuccessfulSyncAt = status?.lastSuccessfulSyncAt?.toSeoulOffsetDateTime(),
                lastFailedSyncAt = status?.lastFailedSyncAt?.toSeoulOffsetDateTime(),
            )
        }
        val readySources = sources.filter { it.indexReady }
        val searchState = when {
            readySources.isNotEmpty() && readySources.size < sources.size ->
                SupportProgramSearchState.SEARCHABLE_WITH_PARTIAL_SOURCES
            readySources.any { it.searchState == SupportProgramSearchState.SEARCHABLE_WITH_SYNC_FAILURE } ->
                SupportProgramSearchState.SEARCHABLE_WITH_SYNC_FAILURE
            readySources.isNotEmpty() -> SupportProgramSearchState.SEARCHABLE
            sources.any { it.searchState == SupportProgramSearchState.UNAVAILABLE } ->
                SupportProgramSearchState.UNAVAILABLE
            else -> SupportProgramSearchState.PREPARING
        }
        return SupportProgramSearchReadinessResult(
            searchState = searchState,
            programCount = readySources.sumOf { it.programCount },
            indexReady = readySources.isNotEmpty(),
            lastSuccessfulSyncAt = sources.mapNotNull { it.lastSuccessfulSyncAt }.maxOrNull(),
            lastFailedSyncAt = sources.mapNotNull { it.lastFailedSyncAt }.maxOrNull(),
            sources = java.util.List.copyOf(sources),
        )
    }

    private fun stateFor(status: SupportProgramSyncStatus?): SupportProgramSearchState =
        when {
            status == null -> SupportProgramSearchState.PREPARING
            !status.indexReady && status.publishedGeneration == null &&
                status.publishedProgramCount == 0 && status.lastSyncOutcome == SupportProgramSyncOutcome.NONE ->
                SupportProgramSearchState.PREPARING
            !status.indexReady -> SupportProgramSearchState.UNAVAILABLE
            status.lastSyncOutcome == SupportProgramSyncOutcome.FAILURE ->
                SupportProgramSearchState.SEARCHABLE_WITH_SYNC_FAILURE
            else -> SupportProgramSearchState.SEARCHABLE
        }

    private fun LocalDateTime.toSeoulOffsetDateTime(): OffsetDateTime =
        atZone(clock.zone).toOffsetDateTime()
}
