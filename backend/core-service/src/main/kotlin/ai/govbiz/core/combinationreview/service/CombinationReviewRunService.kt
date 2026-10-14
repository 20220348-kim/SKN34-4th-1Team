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
import ai.govbiz.core.aiusage.domain.AiUsageFeature
import ai.govbiz.core.aiusage.helper.AiUsageContextHelper
import ai.govbiz.core.supportprogram.client.ops.ProductionQualityClient
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityContextRequest
import org.slf4j.LoggerFactory

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
    private val productionQuality: ProductionQualityClient,
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
                        warnings.add("사업 ${index + 1}: 자동 분석 제외 첨부(${error.reason.excludedLabel}): ${file.fileName.take(250)}. 원본 대조가 필요합니다.")
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
            val analysis = AiUsageContextHelper.attribute(runs.findOwnerId(run.id), AiUsageFeature.COMBINATION_REVIEW) {
                ai.analyze(run.input, evidence, configuration)
            }
            runs.succeed(run.id, analysis)
            recordReviewQuality(run.input, evidence, analysis)
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

    /** 확정 저장 뒤 모델에 전달한 검토 조건·공개 근거와 실제 판정을 복사한다. 계정·원본 파일·URL은 제외한다. */
    private fun recordReviewQuality(input: ReviewRunSnapshot, evidence: ReviewEvidenceSnapshot, analysis: ReviewAnalysis) {
        runCatching {
            val cited = analysis.pairs.flatMap { pair ->
                pair.stages.flatMap { it.citations } + pair.answers.flatMap { answer ->
                    answer.citations + answer.conditions.flatMap { it.citations } + answer.consequences.flatMap { it.citations }
                }
            }.map { it.evidenceId }.toSet()
            // 인용된 근거를 앞에 놓고 두 공고를 번갈아 수집해 첫 공고만으로 상한을 채우지 않는다.
            val programBlocks = input.programs.indices.map { index ->
                evidence.blocks.filter { it.programIndex == index }.sortedBy { it.id !in cited }
            }
            val orderedBlocks = (0 until (programBlocks.maxOfOrNull { it.size } ?: 0)).flatMap { index ->
                programBlocks.mapNotNull { it.getOrNull(index) }
            }
            val contexts = buildList {
                input.programs.forEachIndexed { index, program ->
                    add(ProductionQualityContextRequest("program-${index + 1}", "사업 ${index + 1} · 선택 조건", buildString {
                        appendLine("공고: ${program.identity.sourceCode}:${program.identity.sourceProgramId}")
                        with(program.participation) {
                            appendLine("신청: $applicationSubmitted / 선정: $selected / 확약: $commitmentSubmitted")
                            append("협약: $agreementSigned / 수행: $executionStatus / 지원금 수령: $fundingReceived")
                        }
                    }))
                }
                add(ProductionQualityContextRequest("review-conditions", "검토 상황", buildString {
                    appendLine("기준일: ${input.asOfDate}")
                    appendLine("같은 과제: ${input.relation.sameProject} / 같은 비용: ${input.relation.sameCost}")
                    append("추가 상황: ${input.additionalFacts.ifBlank { "없음" }}")
                }))
                addAll(orderedBlocks.map { block ->
                    ProductionQualityContextRequest(block.id, "사업 ${block.programIndex + 1} · ${block.locator}", block.text)
                })
                if (evidence.coverageWarnings.isNotEmpty()) {
                    // 기존 경고에는 원본 파일명이 들어갈 수 있어 개수와 한계만 남긴다.
                    add(ProductionQualityContextRequest("coverage", "근거 수집 제한",
                        "읽지 못하거나 제외된 첨부 관련 경고 ${evidence.coverageWarnings.size}건. 원문 전체가 포함되지 않았을 수 있습니다."))
                }
            }
            productionQuality.recordOperation(
                scope = "combination-review",
                question = "선택한 두 공고의 중복 신청·동시 수행·동일 과제와 비용의 중복 지원 가능성을 검토해 주세요.",
                contexts = contexts,
                output = buildString {
                    appendLine(analysis.summary)
                    analysis.pairs.forEach { pair ->
                        appendLine("사업 ${pair.firstProgramIndex + 1} / 사업 ${pair.secondProgramIndex + 1}")
                        pair.stages.forEach { stage ->
                            appendLine("${stage.stage}: ${stage.judgment} · ${stage.scope}")
                            appendLine(stage.explanation)
                            stage.questions.forEach { appendLine("확인 질문: $it") }
                            appendLine("기관 확인 필요: ${stage.requiresInstitutionConfirmation}")
                            stage.citations.forEach { appendLine("근거 [${it.evidenceId}]: ${it.quote}") }
                        }
                        pair.answers.forEach { answer ->
                            appendLine("${answer.question}: ${answer.verdict}")
                            appendLine(answer.explanation)
                            answer.conditions.forEach { condition ->
                                appendLine("조건: ${condition.condition} → ${condition.result}")
                                condition.citations.forEach { appendLine("근거 [${it.evidenceId}]: ${it.quote}") }
                            }
                            answer.consequences.forEach { consequence ->
                                appendLine("${consequence.moment}: ${consequence.action}")
                                consequence.citations.forEach { appendLine("근거 [${it.evidenceId}]: ${it.quote}") }
                            }
                            appendLine("기관 확인 질문: ${answer.institutionQuestion}")
                            answer.citations.forEach { appendLine("근거 [${it.evidenceId}]: ${it.quote}") }
                        }
                    }
                    analysis.limitations.forEach { appendLine("제한 사항: $it") }
                },
                outputStatus = if (analysis.pairs.any { pair ->
                    pair.stages.any { it.judgment in setOf(ReviewJudgment.INSUFFICIENT_EVIDENCE, ReviewJudgment.CONFLICTING_EVIDENCE) } ||
                        pair.answers.any { it.verdict in setOf(ReviewVerdict.NO_RULE, ReviewVerdict.ASK_INSTITUTION) }
                }) "INSUFFICIENT_EVIDENCE" else "COMPLETED",
            )
        }.onFailure { logger.warn("production_quality_sample_skipped scope=combination-review reason=snapshot") }
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
        val logger = LoggerFactory.getLogger(CombinationReviewRunService::class.java)
        const val MAX_REVIEW_SOURCE_DOCUMENTS = 12
        val NUMERIC_PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
    }
}
