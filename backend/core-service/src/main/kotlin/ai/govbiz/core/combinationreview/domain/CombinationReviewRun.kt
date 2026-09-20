package ai.govbiz.core.combinationreview.domain

import java.time.LocalDate
import java.time.LocalDateTime

enum class ReviewRunStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, INTERRUPTED, UNKNOWN }
enum class ReviewStage { APPLICATION, SELECTION, COMMITMENT, AGREEMENT, EXECUTION, FUNDING }
enum class ReviewJudgment { RESTRICTION_APPLIES, PERMISSION_IN_SCOPE, NEEDS_FACTS, INSUFFICIENT_EVIDENCE, CONFLICTING_EVIDENCE }

data class ReviewRunSnapshot(
    val title: String,
    val programs: List<SelectedReviewProgram>,
    val additionalFacts: String,
    val asOfDate: LocalDate,
)

data class ReviewEvidenceBlock(val id: String, val programIndex: Int, val documentHash: String, val locator: String, val text: String)
data class ReviewSourceBlock(val locator: String, val text: String)
data class ReviewSourceDocument(
    val programIndex: Int,
    val sourceUrl: String,
    val fileName: String,
    val format: String,
    val rawHash: String,
    val textHash: String,
    val parserVersion: String,
    val fetchedAt: LocalDateTime,
    /** 기존 실행 JSON에는 없을 수 있으며, sourceUrl(첨부 파일 주소)과 역할이 다릅니다. */
    val sourcePageUrl: String? = null,
)
data class ReviewEvidenceSnapshot(
    val documents: List<ReviewSourceDocument>,
    val blocks: List<ReviewEvidenceBlock>,
    val coverageWarnings: List<String>,
)
data class ReviewModelConfiguration(val contractVersion: String, val model: String, val promptVersion: String)
data class ReviewCitation(val evidenceId: String, val quote: String)
data class ReviewStageJudgment(
    val stage: ReviewStage, val judgment: ReviewJudgment, val scope: String, val explanation: String,
    val questions: List<String>, val requiresInstitutionConfirmation: Boolean, val citations: List<ReviewCitation>,
)
data class ReviewPairJudgments(val firstProgramIndex: Int, val secondProgramIndex: Int, val stages: List<ReviewStageJudgment>)
data class ReviewAnalysis(val summary: String, val pairs: List<ReviewPairJudgments>, val limitations: List<String>)
data class StoredCombinationReviewRun(
    val id: Long, val reviewId: Long, val inputRevision: Long, val requestKey: String, val requestHash: String,
    val status: ReviewRunStatus, val input: ReviewRunSnapshot, val evidence: ReviewEvidenceSnapshot?,
    val configuration: ReviewModelConfiguration?, val analysis: ReviewAnalysis?, val failureCode: String?,
    val runnerInstanceId: String, val startedAt: LocalDateTime, val finishedAt: LocalDateTime?,
)

data class ReviewRunReservation(val run: StoredCombinationReviewRun, val created: Boolean)
data class ReviewRunSummary(val id: Long, val inputRevision: Long, val status: ReviewRunStatus, val failureCode: String?, val startedAt: LocalDateTime, val finishedAt: LocalDateTime?)
