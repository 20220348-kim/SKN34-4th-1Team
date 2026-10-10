package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.combinationreview.config.CombinationReviewProperties
import ai.govbiz.core.combinationreview.facade.AiCombinationReviewFacade
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException
import ai.govbiz.core.combinationreview.helper.CombinationReviewHashHelper
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewNotFoundException
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewCapacityException
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import ai.govbiz.core.combinationreview.service.exception.*
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import java.time.Clock
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import java.util.UUID
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/** HTTP는 입력 스냅샷만 접수한다. 큐 소비자가 DB transaction 밖에서 수집·파싱·AI를 실행한다. */
@Service
class CombinationReviewRunService(
    private val runs: CombinationReviewRunRepository, private val reviews: CombinationReviewService,
    private val bizInfoAttachments: BizInfoAttachmentClient, private val msitAttachments: MsitAttachmentClient,
    private val kStartupAttachments: KStartupAttachmentClient,
    private val cnTradeNoticeAttachments: CnTradeNoticeAttachmentClient,
    private val programDetails: SupportProgramDetailService, private val documentParser: SupportProgramDocumentParser,
    private val ai: AiCombinationReviewFacade, private val admission: SupportProgramRequestAdmissionService,
    private val planUsage: PlanUsageService, transactionManager: PlatformTransactionManager,
    @param:Qualifier("seoulClock") private val clock: Clock,
    @param:Value("\${app.combination-review.queue.enabled:false}") private val queueEnabled: Boolean,
    private val properties: CombinationReviewProperties,
) {
    private val runnerInstanceId = UUID.randomUUID().toString()
    private val transactions = TransactionTemplate(transactionManager)

    fun start(account: Account, reviewId: Long, expectedRevision: Long, requestKey: String, additionalFacts: String): ReviewRunReservation {
        runs.replay(account.id, reviewId, expectedRevision, requestKey, additionalFacts)?.let { return it }
        if (reviews.findOwned(account, reviewId).draft.input.programs.size != 2) {
            throw CombinationReviewRunException(ReviewRunFailureCode.INPUT_PROGRAM_COUNT_UNSUPPORTED)
        }
        if (!queueEnabled) throw CombinationReviewRunException(ReviewRunFailureCode.RUN_QUEUE_UNAVAILABLE)
        try {
            return admission.execute("combination-review-account:${account.id}") {
                // 새 실행 접수와 월 한도 확인을 한 transaction으로 묶어 한도를 넘는 실행은 남기지 않는다.
                requireNotNull(transactions.execute { _ ->
                    runs.reserve(account.id, reviewId, expectedRevision, requestKey, additionalFacts, runnerInstanceId).also { reservation ->
                        if (reservation.created) planUsage.requireMonthlyCapacity(account.id, PlanUsageJob.ReviewRun(reservation.run.id))
                    }
                })
            }
        } catch (_: CombinationReviewCapacityException) {
            throw CombinationReviewRunException(ReviewRunFailureCode.RUN_CAPACITY_EXCEEDED, retryAfterSeconds = 60)
        } catch (error: SupportProgramRequestRejectedException) {
            val code = if (error.reason == SupportProgramRequestRejectedException.Reason.RATE_LIMITED) ReviewRunFailureCode.RUN_RATE_LIMITED else ReviewRunFailureCode.RUN_CAPACITY_EXCEEDED
            throw CombinationReviewRunException(code, cause = error, retryAfterSeconds = error.retryAfterSeconds)
        }
    }

    fun executeQueued(runId: Long) {
        try {
            admission.executeBackground { executeClaimed(runId) }
        } catch (error: SupportProgramRequestRejectedException) {
            if (error.reason != SupportProgramRequestRejectedException.Reason.BUSY) throw error
            // 아직 선점하지 않은 QUEUED 작업이다. ACK 후 Outbox가 다시 전달하며 과금 호출은 하지 않았다.
        }
    }

    private fun executeClaimed(runId: Long) {
        val run = runs.claim(runId, runnerInstanceId) ?: return
        var analysisStarted = false
        try {
            if (run.input.programs.size != 2) {
                throw CombinationReviewRunException(ReviewRunFailureCode.INPUT_PROGRAM_COUNT_UNSUPPORTED, run.id)
            }
            val documents = mutableListOf<ReviewSourceDocument>()
            val blocks = mutableListOf<ReviewEvidenceBlock>()
            val raw = mutableListOf<ByteArray>()
            val warnings = mutableListOf<String>()
            run.input.programs.forEachIndexed { index, program ->
                if (program.identity.subProgramId != null) {
                    throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED)
                }
                val fetched = collectAttachments(program.identity)
                if (documents.size + fetched.files.size > MAX_REVIEW_SOURCE_DOCUMENTS) {
                    throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.TOO_LARGE)
                }
                warnings.addAll(fetched.warnings.map { "사업 ${index + 1}: $it" })
                var parsedDocumentCount = 0
                var rejectedReason: SupportProgramDocumentException.Reason? = null
                fetched.files.forEach { file ->
                    val parsed = try {
                        documentParser.parseEvidence(file.bytes, file.format)
                    } catch (error: SupportProgramDocumentException) {
                        if (error.reason !in setOf(
                                SupportProgramDocumentException.Reason.UNSUPPORTED,
                                SupportProgramDocumentException.Reason.TOO_LARGE,
                            )
                        ) throw error
                        rejectedReason = error.reason
                        warnings.add("사업 ${index + 1}: 자동 분석 제외 첨부(SOURCE_${error.reason.name}): ${file.fileName.take(250)}. 원본 대조가 필요합니다.")
                        return@forEach
                    }
                    val document = ReviewSourceDocument(
                        index,
                        file.sourceUrl,
                        file.fileName,
                        file.format,
                        CombinationReviewHashHelper.sha256(file.bytes),
                        CombinationReviewHashHelper.sha256(parsed.joinToString("\n") { it.text }),
                        SupportProgramDocumentParser.EVIDENCE_VERSION,
                        LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS),
                        fetched.sourcePageUrl,
                    )
                    documents.add(document)
                    parsed.forEach { block -> blocks.add(ReviewEvidenceBlock("E${blocks.size}", index, document.rawHash, block.locator, block.text)) }
                    raw.add(file.bytes)
                    parsedDocumentCount++
                }
                if (parsedDocumentCount == 0) {
                    throw SupportProgramDocumentException(
                        rejectedReason ?: SupportProgramDocumentException.Reason.UNSUPPORTED,
                    )
                }
            }
            if (blocks.size > 512 || blocks.sumOf { it.text.length } > 120_000) throw CombinationReviewRunException(ReviewRunFailureCode.SOURCE_TOO_LARGE)
            val evidence = ReviewEvidenceSnapshot(documents, blocks, warnings.distinct())
            runs.saveEvidence(run.id, evidence, raw)
            // 계약 버전은 접수 시점이 아니라 실제 실행 시점의 설정을 따른다. 지난 실행은 저장된 설정으로 읽는다.
            val configuration = ai.configuration(properties.reviewContractVersion)
            runs.saveConfiguration(run.id, configuration)
            analysisStarted = true
            val analysis = ai.analyze(run.input, evidence, configuration)
            runs.succeed(run.id, analysis)
        } catch (error: Exception) {
            val code = failureCode(error)
            // 검증 실패는 확정 실패다. 호출/결과 저장 중 단절은 과금 여부를 알 수 없어 자동 재호출하지 않는다.
            if (analysisStarted && code !in setOf(ReviewRunFailureCode.ANALYSIS_INVALID, ReviewRunFailureCode.SOURCE_TOO_LARGE)) {
                runs.markUnknown(run.id, "RUN_OUTCOME_UNKNOWN")
            } else {
                runs.fail(run.id, code.name)
            }
        }
    }

    fun findOwned(account: Account, reviewId: Long, runId: Long): StoredCombinationReviewRun =
        runs.findOwned(account.id, reviewId, runId) ?: throw CombinationReviewNotFoundException()

    fun listOwned(account: Account, reviewId: Long, beforeId: Long?, size: Int): List<ReviewRunSummary> {
        reviews.findOwned(account, reviewId)
        return runs.listOwned(account.id, reviewId, beforeId, size + 1)
    }

    fun download(account: Account, reviewId: Long, runId: Long, documentIndex: Int): Pair<ReviewSourceDocument, ByteArray> {
        val run = findOwned(account, reviewId, runId)
        val doc = run.evidence?.documents?.getOrNull(documentIndex) ?: throw CombinationReviewNotFoundException()
        val bytes = runs.findSource(account.id, reviewId, runId, documentIndex) ?: throw CombinationReviewNotFoundException()
        return doc to bytes
    }

    private fun collectAttachments(identity: ReviewProgramIdentity): SupportProgramAttachments = when (identity.sourceCode) {
        "BIZINFO" -> bizInfoAttachments.collect(identity.sourceCode, identity.sourceProgramId)
        "MSIT" -> {
            if (!NUMERIC_PROGRAM_ID.matches(identity.sourceProgramId)) {
                throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED)
            }
            val program = requireProgram(identity)
            msitAttachments.collect(identity.sourceCode, identity.sourceProgramId, program.sourceUrl)
        }
        "KSTARTUP" -> {
            if (!NUMERIC_PROGRAM_ID.matches(identity.sourceProgramId)) {
                throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED)
            }
            val program = requireProgram(identity)
            kStartupAttachments.collect(identity.sourceCode, identity.sourceProgramId, program.sourceUrl)
        }
        "CNTRADE_NOTICE" -> {
            if (!NUMERIC_PROGRAM_ID.matches(identity.sourceProgramId)) {
                throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED)
            }
            val program = requireProgram(identity)
            cnTradeNoticeAttachments.collect(identity.sourceCode, identity.sourceProgramId, program.title, program.targetDescription)
        }
        else -> throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED)
    }

    private fun requireProgram(identity: ReviewProgramIdentity) = try {
        programDetails.get(identity.sourceCode, identity.sourceProgramId)
    } catch (error: SupportProgramNotFoundException) {
        throw SupportProgramDocumentException(SupportProgramDocumentException.Reason.NOT_FOUND, error)
    }

    /** 각 하위 경계의 실패를 실행 상태·공개 오류 계약으로 변환한다. */
    private fun failureCode(error: Exception): ReviewRunFailureCode = when (error) {
        is CombinationReviewRunException -> error.code
        is SupportProgramDocumentException -> when (error.reason) {
            SupportProgramDocumentException.Reason.UNSUPPORTED -> ReviewRunFailureCode.SOURCE_UNSUPPORTED
            SupportProgramDocumentException.Reason.NOT_FOUND -> ReviewRunFailureCode.SOURCE_NOT_FOUND
            SupportProgramDocumentException.Reason.UNAVAILABLE -> ReviewRunFailureCode.SOURCE_UNAVAILABLE
            SupportProgramDocumentException.Reason.INVALID -> ReviewRunFailureCode.SOURCE_INVALID
            SupportProgramDocumentException.Reason.TOO_LARGE -> ReviewRunFailureCode.SOURCE_TOO_LARGE
        }
        is AiCombinationReviewFacadeException -> when (error.reason) {
            AiCombinationReviewFacadeException.Reason.UNAVAILABLE -> ReviewRunFailureCode.ANALYSIS_UNAVAILABLE
            AiCombinationReviewFacadeException.Reason.INVALID_RESPONSE -> ReviewRunFailureCode.ANALYSIS_INVALID
            AiCombinationReviewFacadeException.Reason.CONTEXT_TOO_LARGE -> ReviewRunFailureCode.SOURCE_TOO_LARGE
        }
        else -> ReviewRunFailureCode.RUN_FAILED
    }

    private companion object {
        const val MAX_REVIEW_SOURCE_DOCUMENTS = 12
        val NUMERIC_PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
    }
}
