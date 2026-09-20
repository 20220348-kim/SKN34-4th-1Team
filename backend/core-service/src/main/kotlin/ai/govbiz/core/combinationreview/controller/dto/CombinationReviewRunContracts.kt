package ai.govbiz.core.combinationreview.controller.dto

import ai.govbiz.core.combinationreview.domain.*
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId

data class StartCombinationReviewRunRequest(
    @field:Min(1) val expectedRevision: Long,
    @field:Pattern(regexp = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") val requestKey: String,
    @field:Size(max = 8000) val additionalFacts: String = "",
)
data class ReviewRunInputResponse(val title: String, val programs: List<SelectedReviewProgramResponse>, val additionalFacts: String, val asOfDate: String)
data class ReviewEvidenceBlockResponse(val id: String, val programIndex: Int, val documentHash: String, val locator: String, val text: String)
data class ReviewDocumentResponse(
    val programIndex: Int, val sourceUrl: String, val sourcePageUrl: String?, val fileName: String, val format: String,
    val rawHash: String, val textHash: String, val parserVersion: String, val fetchedAt: OffsetDateTime,
)
data class ReviewEvidenceResponse(val documents: List<ReviewDocumentResponse>, val blocks: List<ReviewEvidenceBlockResponse>, val coverageWarnings: List<String>, val reviewStatus: String = "AUTOMATIC_UNREVIEWED")
data class ReviewConfigurationResponse(val contractVersion: String, val model: String, val promptVersion: String)
data class ReviewCitationResponse(val evidenceId: String, val quote: String)
data class ReviewStageResponse(val stage: String, val judgment: String, val scope: String, val explanation: String, val questions: List<String>, val requiresInstitutionConfirmation: Boolean, val citations: List<ReviewCitationResponse>)
data class ReviewPairResponse(val firstProgramIndex: Int, val secondProgramIndex: Int, val stages: List<ReviewStageResponse>)
data class ReviewAnalysisResponse(val summary: String, val pairs: List<ReviewPairResponse>, val limitations: List<String>)
data class CombinationReviewRunResponse(
    val id: Long, val reviewId: Long, val inputRevision: Long, val requestKey: String, val status: String,
    val input: ReviewRunInputResponse, val evidence: ReviewEvidenceResponse?, val configuration: ReviewConfigurationResponse?,
    val analysis: ReviewAnalysisResponse?, val failureCode: String?, val startedAt: OffsetDateTime, val finishedAt: OffsetDateTime?,
) {
    companion object {
        fun from(run: StoredCombinationReviewRun) = CombinationReviewRunResponse(
            run.id, run.reviewId, run.inputRevision, run.requestKey, run.status.name,
            ReviewRunInputResponse(run.input.title, run.input.programs.map(SelectedReviewProgramResponse::from), run.input.additionalFacts, run.input.asOfDate.toString()),
            run.evidence?.let { e -> ReviewEvidenceResponse(
                e.documents.map { ReviewDocumentResponse(it.programIndex, it.sourceUrl, it.sourcePageUrl, it.fileName, it.format, it.rawHash, it.textHash, it.parserVersion, it.fetchedAt.offset()) },
                e.blocks.map { ReviewEvidenceBlockResponse(it.id, it.programIndex, it.documentHash, it.locator, it.text) }, e.coverageWarnings,
            ) },
            run.configuration?.let { ReviewConfigurationResponse(it.contractVersion, it.model, it.promptVersion) },
            run.analysis?.let { a -> ReviewAnalysisResponse(a.summary, a.pairs.map { p -> ReviewPairResponse(p.firstProgramIndex, p.secondProgramIndex,
                p.stages.map { s -> ReviewStageResponse(s.stage.name, s.judgment.name, s.scope, s.explanation, s.questions, s.requiresInstitutionConfirmation,
                    s.citations.map { ReviewCitationResponse(it.evidenceId, it.quote) }) }) }, a.limitations) },
            run.failureCode, run.startedAt.offset(), run.finishedAt?.offset(),
        )
    }
}
data class CombinationReviewRunSummaryResponse(val id: Long, val inputRevision: Long, val status: String, val failureCode: String?, val startedAt: OffsetDateTime, val finishedAt: OffsetDateTime?) {
    companion object {
        fun from(run: ReviewRunSummary) = CombinationReviewRunSummaryResponse(run.id, run.inputRevision, run.status.name, run.failureCode, run.startedAt.offset(), run.finishedAt?.offset())
    }
}
data class CombinationReviewRunPageResponse(val items: List<CombinationReviewRunSummaryResponse>, val nextBeforeId: Long?)
private fun LocalDateTime.offset() = atZone(ZoneId.of("Asia/Seoul")).toOffsetDateTime()
