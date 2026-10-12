package ai.govbiz.core.supportprogram.service.search

import ai.govbiz.core._common.domain.RegionDictionary
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramDuplicatePostings
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramRankingExclusions
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver
import ai.govbiz.core.supportprogram.facade.SupportProgramRankingFacade
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRetrievalFacade
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchResult
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchTrace
import java.time.LocalDate
import java.time.Clock
import ai.govbiz.core.supportprogram.helper.SupportProgramSearchTracingHelper
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 공식 공고 후보와 LLM 점수화를 연결하는 검색 유스케이스입니다. */
@Service
class SupportProgramSearchService(
    private val supportProgramRepository: SupportProgramRepository,
    private val rankingFacade: SupportProgramRankingFacade,
    private val retrievalFacade: AiSupportProgramRetrievalFacade,
    @param:Qualifier("seoulClock") private val clock: Clock,
    private val tracing: SupportProgramSearchTracingHelper = SupportProgramSearchTracingHelper(),
) {
    fun search(
        rawQuery: String?,
        acceptingOnly: Boolean,
        companyConditions: SupportProgramCompanyConditions? = null,
    ): SupportProgramSearchResult = execute(rawQuery, acceptingOnly, companyConditions = companyConditions).result

    /**
     * 평가 전용 호출입니다. 공개 검색 응답에는 노출하지 않고, 비어 있지 않은 질문에서 실제 결합 검색 후보와
     * 최종 추천 공고의 제공처 포함 식별자를 남깁니다.
     */
    fun searchWithTrace(
        rawQuery: String?,
        acceptingOnly: Boolean,
        companyConditions: SupportProgramCompanyConditions? = null,
    ): SupportProgramSearchTrace =
        trace(execute(rawQuery, acceptingOnly, companyConditions = companyConditions))

    /** 평가 기준 날짜의 접수 상태로만 후보·최종 결과를 기록합니다. */
    fun searchWithTrace(
        rawQuery: String?,
        acceptingOnly: Boolean,
        referenceDate: LocalDate,
        companyConditions: SupportProgramCompanyConditions? = null,
    ): SupportProgramSearchTrace = trace(execute(rawQuery, acceptingOnly, referenceDate, companyConditions))

    private fun trace(execution: SearchExecution): SupportProgramSearchTrace {
        require(execution.query.isNotBlank()) { "search trace requires a nonblank query" }
        return SupportProgramSearchTrace(
            result = execution.result,
            candidateIds = immutableCanonicalIds(execution.candidates.map(CatalogSupportProgram::program)),
            finalProgramIds = immutableCanonicalIds(execution.result.programs),
            presentProgramCount = execution.presentProgramCount,
            eligibleProgramCount = execution.eligibleProgramCount,
            eligibleCatalogFingerprint = SupportProgramCatalogFingerprintHelper.calculate(execution.eligiblePrograms),
        )
    }

    private fun execute(
        rawQuery: String?,
        acceptingOnly: Boolean,
        referenceDate: LocalDate? = null,
        companyConditions: SupportProgramCompanyConditions? = null,
    ): SearchExecution = timed("total") {
        val query = rawQuery?.trim().orEmpty()
        val searchReferenceDate = referenceDate ?: companyConditions?.let { LocalDate.now(clock) }
        val presentPrograms = timed("database_fetch") {
            val programs = if (query.isBlank()) {
                supportProgramRepository.findPublishedPresent()
            } else {
                supportProgramRepository.findSearchablePresent()
            }
            if (query.isNotBlank() && programs.isEmpty()) {
                val statuses = supportProgramRepository.findSyncStatuses()
                // 게시된 공고/미복구 기존 공고가 있는데 모든 색인이 불가하면 '검색 결과 없음'이 아닙니다.
                // 초기 빈 DB나 검색 가능한 제공처의 정상 0건 스냅샷은 기존 빈 결과를 유지합니다.
                if (statuses.none { it.indexReady } &&
                    statuses.any { it.publishedGeneration != null || it.publishedProgramCount > 0 }
                ) {
                    throw AiServiceCallException.unavailable(null)
                }
            }
            programs
        }

        val eligiblePrograms = timed("eligibility_prepare") {
            presentPrograms.asSequence()
                .map { program -> searchReferenceDate?.let { program.withStatusAt(it) } ?: program }
                .filter { !acceptingOnly || it.program.status == SupportProgramStatus.OPEN }
                .toList()
        }

        val candidates = when {
            eligiblePrograms.isEmpty() || query.isBlank() -> emptyList()
            else -> timed("retrieval") {
                retrievalFacade.retrieve(
                    buildRetrievalQuery(query, companyConditions),
                    eligiblePrograms,
                )
            }
        }

        var exclusionCounts: SupportProgramRankingExclusions? = null
        val programs = when {
            eligiblePrograms.isEmpty() -> emptyList()
            query.isBlank() -> eligiblePrograms
                .sortedWith(
                    compareByDescending<CatalogSupportProgram> { it.sortTimestamp }
                        .thenBy { it.program.sourceCode }
                        .thenBy { it.program.id },
                )
                .take(SupportProgramRankingFacade.MAX_RESULTS)
                .map { it.program.copy(matchedReasons = emptyList(), recommendationScore = null, eligibilityReview = null) }
            // 검색어에 맞는 후보가 하나도 없으면 순위 매기기를 부르지 않고 살펴본 후보 0건으로 알립니다.
            candidates.isEmpty() -> emptyList<SupportProgram>().also { exclusionCounts = SupportProgramRankingExclusions.NO_CANDIDATES }
            else -> timed("ranking") {
                rankingFacade.rankWithExclusions(
                    query,
                    candidates,
                    SupportProgramRankingFacade.MAX_RESULTS,
                    companyConditions,
                    searchReferenceDate.takeIf { companyConditions != null },
                ).also { exclusionCounts = it.exclusions }.programs
            }
                // 랭킹 입력은 그대로 두고, 다른 제공처가 따로 올린 같은 공고를 순위가 높은 칸 하나에 묶습니다.
                .let { ranked -> SupportProgramDuplicatePostings.group(ranked, eligiblePrograms.map(CatalogSupportProgram::program)) }
                .let { grouped -> demoteOtherRegionPrograms(grouped, companyConditions?.region) }
        }

        tracing.recordSelection(candidates.map { it.program.sourceQualifiedId }, programs.map { it.sourceQualifiedId })
        SearchExecution(
            query = query,
            result = SupportProgramSearchResult(
                query = query,
                programs = java.util.List.copyOf(programs),
                exclusionCounts = exclusionCounts,
            ),
            candidates = java.util.List.copyOf(candidates),
            presentProgramCount = presentPrograms.size,
            eligibleProgramCount = eligiblePrograms.size,
            eligiblePrograms = java.util.List.copyOf(eligiblePrograms),
        )
    }

    private fun buildRetrievalQuery(
        query: String,
        conditions: SupportProgramCompanyConditions?,
    ): String {
        if (conditions == null) return query
        // 의미·키워드 검색에는 실제 검색 조건만 사용합니다. 설립일과 서울 기준일은 자격 판단에만 전달하며,
        // 시스템 표제나 날짜가 공고의 지역·신청기간과 우연히 일치해 후보 순위를 바꾸지 않게 합니다.
        return listOfNotNull(query, conditions.region, conditions.industry, conditions.supportPurpose)
            .joinToString("\n")
            .also {
                // 공개 필드별 상한의 합보다 넉넉하지만 내부 검색 계약(1000자)을 넘길 수는 없습니다.
                require(it.length <= 1000) { "condition-aware retrieval query exceeds the internal limit" }
            }
    }

    /**
     * 전국이 아닌 지역 태그가 회사 소재지와 겹치지 않는 공고는 빼지 않고 관련도순 결과의 뒤로 보내 표시합니다.
     * 본문 인용으로 지역을 확인(MATCH)한 공고는 태그보다 본문을 따릅니다. 같은 그룹 안의 관련도 순서는 유지합니다.
     */
    private fun demoteOtherRegionPrograms(programs: List<SupportProgram>, companyRegion: String?): List<SupportProgram> {
        if (companyRegion == null) return programs
        val (otherRegion, sameOrUnknown) = programs.map { program ->
            val outside = program.eligibilityReview?.region?.status != SupportProgramEligibilityStatus.MATCH &&
                RegionDictionary.isOutsideTaggedRegions(companyRegion, program.regions)
            if (outside) program.copy(regionTagMismatch = true) else program
        }.partition(SupportProgram::regionTagMismatch)
        return sameOrUnknown + otherRegion
    }

    private fun immutableCanonicalIds(programs: List<SupportProgram>): List<String> =
        java.util.List.copyOf(programs.map(SupportProgram::sourceQualifiedId))

    private fun CatalogSupportProgram.withStatusAt(referenceDate: LocalDate): CatalogSupportProgram =
        copy(
            program = program.copy(
                status = SupportProgramStatusResolver.resolve(
                    applicationPeriod = program.applicationPeriod,
                    applicationStartDate = program.applicationStartDate,
                    applicationEndDate = program.applicationEndDate,
                    today = referenceDate,
                ),
            ),
        )

    private fun <T> timed(stage: String, action: () -> T): T = tracing.observe(stage) {
        val started = System.nanoTime()
        var completed = false
        try {
            action().also { completed = true }
        } finally {
            logger.info(
                "support_program_search stage={} outcome={} duration_ms={}",
                stage, if (completed) "success" else "failure", (System.nanoTime() - started) / 1_000_000.0,
            )
        }
    }

    private companion object {
        val logger = LoggerFactory.getLogger(SupportProgramSearchService::class.java)
    }

    private data class SearchExecution(
        val query: String,
        val result: SupportProgramSearchResult,
        val candidates: List<CatalogSupportProgram>,
        val presentProgramCount: Int,
        val eligibleProgramCount: Int,
        val eligiblePrograms: List<CatalogSupportProgram>,
    )
}
