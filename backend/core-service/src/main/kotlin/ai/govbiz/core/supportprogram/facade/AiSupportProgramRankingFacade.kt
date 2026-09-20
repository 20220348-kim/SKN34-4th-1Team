package ai.govbiz.core.supportprogram.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.ai.AiSupportProgramRankingClient
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibility
import ai.govbiz.core.supportprogram.client.ai.dto.AiScoredSupportProgramPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramCandidateRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramCompanyConditionsRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibilityEvidencePayload
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEligibilityEvidenceField
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReview
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReviewStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityAssessment
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityEvidence
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityEvidenceField
import java.time.LocalDate
import org.springframework.stereotype.Component

/** 검색 Service에 LLM 점수화의 요청·검증·변환 과정을 단일 진입점으로 제공한다. */
@Component
class AiSupportProgramRankingFacade(
    private val client: AiSupportProgramRankingClient,
) : SupportProgramRankingFacade {
    override fun rank(
        query: String,
        candidates: List<CatalogSupportProgram>,
        limit: Int,
        companyConditions: SupportProgramCompanyConditions?,
        referenceDate: LocalDate?,
    ): List<SupportProgram> {
        require(query.isNotBlank()) { "query must not be blank" }
        require(candidates.isNotEmpty()) { "candidates must not be empty" }
        require(candidates.size <= SupportProgramRankingFacade.MAX_CANDIDATES) {
            "too many candidates"
        }
        require(limit in 1..SupportProgramRankingFacade.MAX_RESULTS) {
            "limit is outside the supported range"
        }
        require(candidates.map { it.program.sourceQualifiedId }.distinct().size == candidates.size) {
            "duplicate catalog identities"
        }

        val request = AiSupportProgramRankingRequest(
            originalQuery = query,
            scoringVersion = SCORING_VERSION,
            resultLimit = minOf(limit, candidates.size),
            candidates = java.util.List.copyOf(candidates.map(::toRequestCandidate)),
            companyConditions = companyConditions?.let {
                AiSupportProgramCompanyConditionsRequest(
                    region = it.region,
                    industry = it.industry,
                    establishedOn = it.establishedOn?.toString(),
                    supportPurpose = it.supportPurpose,
                    foundedYear = it.foundedYear,
                    referenceDate = requireNotNull(referenceDate) { "company conditions require a reference date" }.toString(),
                )
            },
        )
        val payload = client.rankSupportPrograms(request)
        return validate(payload, query, candidates, request)
            ?: throw AiServiceCallException.invalidResponse(
                "AI Service support program rankings violated the internal contract",
                null,
            )
    }

    private fun validate(
        payload: AiSupportProgramRankingPayload,
        expectedQuery: String,
        candidates: List<CatalogSupportProgram>,
        request: AiSupportProgramRankingRequest,
    ): List<SupportProgram>? {
        if (payload.originalQuery != expectedQuery || payload.scoringVersion != SCORING_VERSION) {
            return null
        }
        val rankings = payload.rankings ?: return null
        if (rankings.size > request.resultLimit) return null

        val candidatesById = candidates.associateBy { it.program.sourceQualifiedId }
        val candidateOrder = candidates.mapIndexed { index, candidate -> candidate.program.sourceQualifiedId to index }.toMap()
        val transmittedCandidatesById = request.candidates.associateBy { it.id }
        val seenIds = HashSet<String>()
        var previousScore = MAX_TOTAL_SCORE + 1
        var previousCandidateOrder = -1
        val programs = ArrayList<SupportProgram>(rankings.size)
        for (nullableRanking in rankings) {
            val ranking = nullableRanking ?: return null
            val programId = ranking.programId ?: return null
            val candidate = candidatesById[programId] ?: return null
            if (!seenIds.add(programId)) return null

            val score = validatedScore(ranking) ?: return null
            if (!meetsRecommendationMinimum(ranking)) return null
            if (!hasCompatibleEligibility(ranking)) return null
            val review = validatedReview(ranking, transmittedCandidatesById.getValue(programId)) ?: return null
            val order = candidateOrder.getValue(programId)
            if (score > previousScore || (score == previousScore && order < previousCandidateOrder)) return null
            previousScore = score
            previousCandidateOrder = order
            val reasons = validatedReasons(ranking.recommendationReasons) ?: return null
            programs += candidate.program.copy(
                matchedReasons = reasons,
                recommendationScore = score,
                eligibilityReview = review,
            )
        }
        return java.util.List.copyOf(programs)
    }

    private fun validatedScore(ranking: AiScoredSupportProgramPayload): Int? {
        val semantic = ranking.semanticRelevance?.takeIf { it in 0..40 } ?: return null
        val supportType = ranking.supportTypeFit?.takeIf { it in 0..10 } ?: return null
        val total = ranking.totalScore?.takeIf { it in 0..MAX_TOTAL_SCORE } ?: return null
        return total.takeIf { it == 2 * (semantic + supportType) }
    }

    /**
     * AI Service가 모든 후보를 점수화한 뒤 적용하는 추천 최소 기준을 내부 HTTP 경계에서도 다시 검증한다.
     * 실제 요청한 지원을 일부라도 직접 제공하는 의미 관련성 20/40 이상만 추천한다.
     * 자격 확인 여부는 관련도와 별개이며, UNKNOWN이라는 이유만으로 감점하거나 제외하지 않는다.
     */
    private fun meetsRecommendationMinimum(
        ranking: AiScoredSupportProgramPayload,
    ): Boolean =
        ranking.semanticRelevance != null &&
            ranking.semanticRelevance >= MIN_SEMANTIC_RELEVANCE_SCORE

    /**
     * AI Service는 명백히 불일치한 공고를 이미 제외해야 합니다. Core도 같은 계약을 검증해
     * 잘못된 내부 응답이 공개 추천으로 이어지지 않게 합니다.
     */
    private fun hasCompatibleEligibility(ranking: AiScoredSupportProgramPayload): Boolean {
        val targetEligibility = ranking.targetEligibility ?: return false
        val regionEligibility = ranking.regionEligibility ?: return false
        return targetEligibility != AiSupportProgramEligibility.INCOMPATIBLE &&
            regionEligibility != AiSupportProgramEligibility.INCOMPATIBLE
    }

    private fun validatedReview(
        ranking: AiScoredSupportProgramPayload,
        candidate: AiSupportProgramCandidateRequest,
    ): SupportProgramEligibilityReview? {
        if (candidate.sourceTextTruncated &&
            (ranking.targetEligibility != AiSupportProgramEligibility.UNKNOWN ||
                ranking.regionEligibility != AiSupportProgramEligibility.UNKNOWN)
        ) return null
        val target = validatedAssessment(ranking.targetEligibility, ranking.targetExplanation, ranking.targetEvidence, candidate)
            ?: return null
        val region = validatedAssessment(ranking.regionEligibility, ranking.regionExplanation, ranking.regionEvidence, candidate)
            ?: return null
        return SupportProgramEligibilityReview(
            status = if (target.status == SupportProgramEligibilityStatus.MATCH && region.status == SupportProgramEligibilityStatus.MATCH) {
                SupportProgramEligibilityReviewStatus.MATCH
            } else SupportProgramEligibilityReviewStatus.REVIEW_REQUIRED,
            target = target,
            region = region,
        )
    }

    private fun validatedAssessment(
        eligibility: AiSupportProgramEligibility?,
        explanation: String?,
        evidence: List<AiSupportProgramEligibilityEvidencePayload?>?,
        candidate: AiSupportProgramCandidateRequest,
    ): SupportProgramEligibilityAssessment? {
        val status = when (eligibility) {
            AiSupportProgramEligibility.MATCH -> SupportProgramEligibilityStatus.MATCH
            AiSupportProgramEligibility.UNKNOWN -> SupportProgramEligibilityStatus.UNKNOWN
            else -> return null
        }
        val checkedExplanation = explanation?.takeIf { it.isNotBlank() } ?: return null
        if (checkedExplanation.codePointCount(0, checkedExplanation.length) > MAX_EXPLANATION_LENGTH ||
            UNSUPPORTED_TEXT.containsMatchIn(checkedExplanation)
        ) return null
        if (evidence == null || evidence.size > 1 || (status == SupportProgramEligibilityStatus.MATCH && evidence.size != 1)) return null
        val checkedEvidence = ArrayList<SupportProgramEligibilityEvidence>(evidence.size)
        for (item in evidence) {
            val field = item?.field ?: return null
            val quote = item.quote?.takeIf { it.isNotBlank() } ?: return null
            if (quote.codePointCount(0, quote.length) > MAX_EVIDENCE_QUOTE_LENGTH || UNSUPPORTED_TEXT.containsMatchIn(quote)) return null
            val sourceText = when (field) {
                AiSupportProgramEligibilityEvidenceField.SUMMARY -> candidate.summary
                AiSupportProgramEligibilityEvidenceField.TARGET_DESCRIPTION -> candidate.targetDescription
            }
            // 태그나 다른 공고가 아닌, 이번 AI 요청에 실제 보낸 공식 API 본문의 정확한 인용만 인정합니다.
            if (!sourceText.contains(quote)) return null
            checkedEvidence += SupportProgramEligibilityEvidence(
                SupportProgramEligibilityEvidenceField.valueOf(field.name),
                quote,
            )
        }
        return SupportProgramEligibilityAssessment(status, checkedExplanation, java.util.List.copyOf(checkedEvidence))
    }

    private fun validatedReasons(values: List<String?>?): List<String>? {
        if (values == null || values.size !in 1..MAX_REASONS) return null
        val reasons = LinkedHashSet<String>()
        for (value in values) {
            val reason = value?.trim()?.takeIf(String::isNotEmpty) ?: return null
            if (reason.codePointCount(0, reason.length) > MAX_REASON_LENGTH ||
                reason.codePoints().anyMatch(Character::isISOControl)
            ) {
                return null
            }
            reasons += reason
        }
        return java.util.List.copyOf(reasons).takeIf { it.size == values.size }
    }

    private fun toRequestCandidate(candidate: CatalogSupportProgram): AiSupportProgramCandidateRequest {
        val program = candidate.program
        return AiSupportProgramCandidateRequest(
            id = program.sourceQualifiedId,
            title = program.title.takeCodePoints(MAX_TITLE_LENGTH),
            organization = program.organization.takeCodePoints(MAX_ORGANIZATION_LENGTH),
            summary = program.summary.takeCodePoints(MAX_SUMMARY_LENGTH),
            categories = limitedTerms(program.categories),
            regions = limitedTerms(program.regions),
            targetDescription = program.targetDescription.takeCodePoints(MAX_TARGET_LENGTH),
            applicationPeriod = program.applicationPeriod.takeCodePoints(MAX_PERIOD_LENGTH),
            status = program.status.name,
            sourceTextTruncated = program.summary.codePointCount(0, program.summary.length) > MAX_SUMMARY_LENGTH ||
                program.targetDescription.codePointCount(0, program.targetDescription.length) > MAX_TARGET_LENGTH,
        )
    }

    private fun limitedTerms(values: List<String>): List<String> =
        java.util.List.copyOf(
            values.asSequence()
                .take(MAX_TERMS)
                .map { it.takeCodePoints(MAX_TERM_LENGTH) }
                .filter(String::isNotBlank)
                .toList(),
        )

    /** AI Service의 문자 수 계약과 동일하게 세고 UTF-16 surrogate 쌍을 보존합니다. */
    private fun String.takeCodePoints(maximum: Int): String =
        if (codePointCount(0, length) <= maximum) this else substring(0, offsetByCodePoints(0, maximum))

    companion object {
        const val SCORING_VERSION = "govbiz-support-program-ranking-v5"
        private const val MAX_TOTAL_SCORE = 100
        private const val MIN_SEMANTIC_RELEVANCE_SCORE = 20
        private const val MAX_REASONS = 3
        private const val MAX_REASON_LENGTH = 120
        private const val MAX_TITLE_LENGTH = 300
        private const val MAX_ORGANIZATION_LENGTH = 200
        private const val MAX_SUMMARY_LENGTH = 6_000
        private const val MAX_TARGET_LENGTH = 2_000
        private const val MAX_EXPLANATION_LENGTH = 160
        private const val MAX_EVIDENCE_QUOTE_LENGTH = 240
        private val UNSUPPORTED_TEXT = Regex("\\p{C}")
        private const val MAX_PERIOD_LENGTH = 200
        private const val MAX_TERMS = 20
        private const val MAX_TERM_LENGTH = 100
    }
}
