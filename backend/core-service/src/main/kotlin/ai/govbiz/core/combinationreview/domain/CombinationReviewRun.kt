package ai.govbiz.core.combinationreview.domain

import java.time.LocalDate
import java.time.LocalDateTime

enum class ReviewRunStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, INTERRUPTED, UNKNOWN }
enum class ReviewStage { APPLICATION, SELECTION, COMMITMENT, AGREEMENT, EXECUTION, FUNDING }
enum class ReviewJudgment { RESTRICTION_APPLIES, PERMISSION_IN_SCOPE, NEEDS_FACTS, INSUFFICIENT_EVIDENCE, CONFLICTING_EVIDENCE }

/** 새 분석 실행이 따르는 AI 계약. 지난 실행은 저장된 configuration.contractVersion으로 구분한다. */
enum class ReviewContractVersion { V2, V3 }

/** 세 질문(v3): 둘 다 신청할 수 있나요? / 둘 다 되면 함께 수행할 수 있나요? / 같은 과제·비용으로 두 번 받는 것은 아닌가요? */
enum class ReviewQuestion { APPLY, CONCURRENT, SAME_SUBJECT }

/** 세 질문(v3)의 판정. NO_RULE은 규정을 찾지 못했다는 뜻이며 허용이 아니다. */
enum class ReviewVerdict { ALLOWED, CONDITIONAL, NOT_ALLOWED, NO_RULE, ASK_INSTITUTION }
enum class ReviewConditionResult { ALLOWED, NOT_ALLOWED }
enum class ReviewConsequenceMoment { EVALUATION, SELECTION, AGREEMENT, EXECUTION, SETTLEMENT, AFTER }

data class ReviewRunSnapshot(
    val title: String,
    val programs: List<SelectedReviewProgram>,
    val additionalFacts: String,
    val asOfDate: LocalDate,
    /** 기존 실행 JSON에는 없으며, 그때는 모름(UNKNOWN)으로 읽습니다. */
    val relation: ReviewRelation = ReviewRelation(),
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
data class ReviewCondition(val condition: String, val result: ReviewConditionResult, val citations: List<ReviewCitation>)
data class ReviewConsequence(val moment: ReviewConsequenceMoment, val action: String, val citations: List<ReviewCitation>)
data class ReviewQuestionAnswer(
    val question: ReviewQuestion, val verdict: ReviewVerdict, val explanation: String,
    val conditions: List<ReviewCondition>, val consequences: List<ReviewConsequence>,
    val institutionQuestion: String, val citations: List<ReviewCitation>,
)

/** v2 실행은 여섯 단계(stages)만, v3 실행은 세 질문(answers)만 채운다. 기존 v2 결과 JSON에는 answers가 없다. */
data class ReviewPairJudgments(
    val firstProgramIndex: Int,
    val secondProgramIndex: Int,
    val stages: List<ReviewStageJudgment> = emptyList(),
    val answers: List<ReviewQuestionAnswer> = emptyList(),
)
data class ReviewAnalysis(val summary: String, val pairs: List<ReviewPairJudgments>, val limitations: List<String>)
data class StoredCombinationReviewRun(
    val id: Long, val reviewId: Long, val inputRevision: Long, val requestKey: String, val requestHash: String,
    val status: ReviewRunStatus, val input: ReviewRunSnapshot, val evidence: ReviewEvidenceSnapshot?,
    val configuration: ReviewModelConfiguration?, val analysis: ReviewAnalysis?, val failureCode: String?,
    val runnerInstanceId: String, val startedAt: LocalDateTime, val finishedAt: LocalDateTime?,
)

data class ReviewRunReservation(val run: StoredCombinationReviewRun, val created: Boolean)
data class ReviewRunSummary(val id: Long, val inputRevision: Long, val status: ReviewRunStatus, val failureCode: String?, val startedAt: LocalDateTime, val finishedAt: LocalDateTime?)
