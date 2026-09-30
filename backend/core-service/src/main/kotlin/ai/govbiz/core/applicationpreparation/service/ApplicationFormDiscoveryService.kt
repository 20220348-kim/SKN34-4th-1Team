package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.client.ai.exception.AiApplicationFormTooLargeException
import ai.govbiz.core.applicationpreparation.client.ai.exception.AiApplicationFormValidationException
import ai.govbiz.core.applicationpreparation.domain.ApplicationAttachmentRole
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormAnalysisMetadata
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormAvailabilityStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryBlock
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryDocument
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryInput
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryResult
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormFieldDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormSectionDefinition
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.ExtractedApplicationForm
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
import ai.govbiz.core.applicationpreparation.repository.RequestedAnalysisClaimResult
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException.Reason
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import java.security.MessageDigest
import org.springframework.stereotype.Service
import org.slf4j.LoggerFactory

/** 사용자가 선택한 지원 공고의 제공처별 공식 첨부를 분석해 재사용 가능한 양식 스냅샷을 만듭니다. */
@Service
class ApplicationFormDiscoveryService(
    private val details: SupportProgramDetailService,
    private val bizInfoAttachments: BizInfoAttachmentClient,
    private val msitAttachments: MsitAttachmentClient,
    private val kStartupAttachments: KStartupAttachmentClient,
    private val cnTradeNoticeAttachments: CnTradeNoticeAttachmentClient,
    private val parser: SupportProgramDocumentParser,
    private val ai: AiApplicationPreparationFacade,
    private val snapshots: ApplicationFormSnapshotRepository,
    private val documentMapping: ApplicationDocumentMappingService,
    private val admission: SupportProgramRequestAdmissionService,
    private val availability: ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository,
    transactionManager: org.springframework.transaction.PlatformTransactionManager,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val transactions = org.springframework.transaction.support.TransactionTemplate(transactionManager)

    companion object {
        /** 문서별 AI 양식 추출을 동시에 보내는 최대 수입니다. 첨부는 제공처당 최대 8개입니다. */
        const val DISCOVERY_CONCURRENCY = 3
        /** 양식 추출은 성공했으나 입력칸 매핑에서 난 실패입니다. 모델 결과가 일정하지 않아 재시도로 풀릴 수 있습니다. */
        val RETRYABLE_DOCUMENT_FAILURES = setOf("APPLICATION_DOCUMENT_PLAN_FAILED", "APPLICATION_DOCUMENT_MAPPING_FAILED", "APPLICATION_DOCUMENT_PLAN_TIMEOUT")

        private class CandidateOutcome(
            val candidates: List<ExtractedApplicationForm> = emptyList(),
            val failure: Exception? = null,
            val excluded: ApplicationFormDiscoveryDocument? = null,
        )

        fun isRetryableDocumentFailure(error: Throwable): Boolean =
            error is ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException && error.code in RETRYABLE_DOCUMENT_FAILURES

        /** 항목을 최대 [DISCOVERY_CONCURRENCY]개씩 동시에 처리하고 결과를 입력 순서대로 돌려줍니다. 한 항목의 예외는 그대로 던집니다. */
        fun <T, R> mapConcurrently(items: List<T>, block: (T) -> R): List<R> {
            if (items.size <= 1) return items.map(block)
            val executor = java.util.concurrent.Executors.newFixedThreadPool(minOf(items.size, DISCOVERY_CONCURRENCY))
            try {
                val futures = items.map { item -> executor.submit(java.util.concurrent.Callable { block(item) }) }
                return futures.map { future ->
                    try { future.get() } catch (error: java.util.concurrent.ExecutionException) { throw error.cause ?: error }
                }
            } finally {
                executor.shutdownNow()
            }
        }
    }
    fun discover(account: Account, sourceCode: String, sourceProgramId: String): ApplicationFormDiscoveryResult {
        require(account.id > 0)
        validateIdentity(sourceCode, sourceProgramId)
        return admission.execute("application-form-discovery-account:${account.id}") {
            discoverQueued(sourceCode, sourceProgramId) {}
        }
    }

    fun validateIdentity(sourceCode: String, sourceProgramId: String) {
        val validIdentity = when (sourceCode) {
            "BIZINFO" -> Regex("PBLN_[0-9]{1,32}").matches(sourceProgramId)
            "MSIT", "KSTARTUP", "CNTRADE_NOTICE" -> Regex("[1-9][0-9]{0,254}").matches(sourceProgramId)
            else -> false
        }
        if (!validIdentity) {
            throw ApplicationFormDiscoveryException(Reason.SOURCE_UNSUPPORTED)
        }
    }

    /** 큐 실행권과 동시 실행 슬롯은 호출 Service가 소유한다. 유료 호출 직전에 실행권을 재확인한다. */
    fun discoverQueued(sourceCode: String, sourceProgramId: String, beforeAi: () -> Unit): ApplicationFormDiscoveryResult {
        validateIdentity(sourceCode, sourceProgramId)
        val program = try {
            details.get(sourceCode, sourceProgramId)
        } catch (error: SupportProgramNotFoundException) {
            throw ApplicationFormDiscoveryException(Reason.SOURCE_NOT_FOUND, error)
        }
        val configuration = ai.discoveryConfiguration()
        val lease = when (val claim = availability.claimRequested(sourceCode, sourceProgramId)) {
            is RequestedAnalysisClaimResult.Claimed -> claim.lease
            RequestedAnalysisClaimResult.NotFound -> null
            RequestedAnalysisClaimResult.Conflict -> throw ApplicationFormDiscoveryException(Reason.JOB_CONFLICT)
        }
        try {
            return discoverFresh(
                program.sourceCode,
                program.id,
                program.title,
                program.targetDescription,
                program.sourceUrl,
                configuration,
                { beforeAi(); if (lease != null) availability.beforeAi(lease) },
                persist = if (lease == null) null else { forms, metadata ->
                    transactions.executeWithoutResult { availability.available(lease, forms, metadata) }
                },
            )
        } catch (error: Exception) {
            if (lease != null) {
                val reason = when (error) {
                    is ApplicationFormDiscoveryException -> "APPLICATION_FORM_${error.reason.name}"
                    is ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException -> error.code
                    is AiServiceCallException -> "AI_${error.failure.name}"
                    is ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException -> "DISCOVERY_TIMEOUT"
                    else -> "MANUAL_REANALYSIS_FAILED"
                }
                val (status, retryable) = queuedFailureStatus(error)
                availability.finish(lease, status, reason, retryable = retryable, cacheResult = false,
                    timeoutStage = (error as? ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException)?.stage)
            }
            throw error
        }
    }

    /**
     * 사용자 요청 재분석도 스케줄러 분석과 같은 상태로 기록한다. 문서 자체의 확정 사유(양식 없음·크기 초과·수집 불가)는
     * 운영자 검토 대상이 아니고, 일시 장애와 입력칸 매핑 실패만 재시도 대기로 둔다.
     */
    private fun queuedFailureStatus(error: Exception): Pair<ApplicationFormAvailabilityStatus, Boolean> = when {
        // 양식은 찾았지만 입력칸 연결(매핑)만 실패한 경우는 모델 결과가 매번 달라 재시도 가치가 있으므로 하루 잠그지 않습니다.
        isRetryableDocumentFailure(error) -> ApplicationFormAvailabilityStatus.RETRY_WAITING to true
        error is ApplicationFormDiscoveryException -> when (error.reason) {
            Reason.NO_FORM -> ApplicationFormAvailabilityStatus.NO_FORM to false
            Reason.SOURCE_CHANGED -> ApplicationFormAvailabilityStatus.STALE to false
            Reason.SOURCE_TOO_LARGE -> ApplicationFormAvailabilityStatus.TOO_LARGE to false
            Reason.SOURCE_UNAVAILABLE -> ApplicationFormAvailabilityStatus.RETRY_WAITING to true
            Reason.SOURCE_NOT_FOUND, Reason.SOURCE_UNSUPPORTED, Reason.SOURCE_INVALID -> ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE to false
            else -> ApplicationFormAvailabilityStatus.REVIEW_REQUIRED to false
        }
        error is ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException -> ApplicationFormAvailabilityStatus.RETRY_WAITING to true
        error is AiServiceCallException && error.failure.name in setOf("UNAVAILABLE", "TIMEOUT") -> ApplicationFormAvailabilityStatus.RETRY_WAITING to true
        else -> ApplicationFormAvailabilityStatus.REVIEW_REQUIRED to false
    }

    /** 시스템 작업은 계정별 discovery job을 사용하지 않으며 저장 transaction을 호출자가 소유한다. */
    fun analyzeSystem(
        sourceCode: String, sourceProgramId: String,
        configuration: ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration,
        observe: (ApplicationFormAnalysisMetadata) -> Unit,
        beforeAi: () -> Unit,
        persist: (List<ApplicationFormManifest>, ApplicationFormAnalysisMetadata) -> Unit,
    ): ApplicationFormDiscoveryResult {
        validateIdentity(sourceCode, sourceProgramId)
        val program = details.get(sourceCode, sourceProgramId)
        return discoverFresh(sourceCode, sourceProgramId, program.title, program.targetDescription, program.sourceUrl,
            configuration, beforeAi, observe, persist)
    }

    private fun discoverFresh(
        sourceCode: String,
        sourceProgramId: String,
        catalogTitle: String,
        catalogBody: String,
        sourceUrl: String,
        configuration: ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration,
        beforeAi: () -> Unit,
        observe: (ApplicationFormAnalysisMetadata) -> Unit = {},
        persist: ((List<ApplicationFormManifest>, ApplicationFormAnalysisMetadata) -> Unit)? = null,
    ): ApplicationFormDiscoveryResult {
        return try {
            val collected = when (sourceCode) {
                "BIZINFO" -> bizInfoAttachments.collect(sourceCode, sourceProgramId)
                "MSIT" -> msitAttachments.collect(sourceCode, sourceProgramId, sourceUrl)
                "KSTARTUP" -> kStartupAttachments.collect(sourceCode, sourceProgramId, sourceUrl)
                "CNTRADE_NOTICE" -> cnTradeNoticeAttachments.collect(sourceCode, sourceProgramId, catalogTitle, catalogBody)
                else -> throw ApplicationFormDiscoveryException(Reason.SOURCE_UNSUPPORTED)
            }
            val warnings = collected.warnings.toMutableList()
            val sourceFingerprint = sha256(collected.files.joinToString("\n") { file ->
                "${file.sourceUrl}\u0000${file.fileName}\u0000${sha256(file.bytes)}"
            }.toByteArray())
            val metadata = ApplicationFormAnalysisMetadata(sourceFingerprint, configuration, SupportProgramDocumentParser.VERSION)
            observe(metadata)
            snapshots.findByProgram(
                sourceCode, sourceProgramId, sourceFingerprint, SupportProgramDocumentParser.VERSION,
                configuration.model, configuration.promptVersion,
            )
                .takeIf { it.isNotEmpty() }?.let { cached ->
                    val bound = bindDocumentMaps(cached, collected.files)
                    persist?.invoke(bound, metadata)
                    return ApplicationFormDiscoveryResult(
                        bound,
                        warnings + "동일한 공식 첨부에서 이전에 추출한 양식을 재사용했습니다.",
                        true,
                    )
                }
            var excludedReason = Reason.SOURCE_UNSUPPORTED
            var hasExcludedDocument = false
            val documents = collected.files.mapIndexedNotNull { documentIndex, file ->
                val blocks = try {
                    parser.parse(file.bytes, file.format)
                } catch (error: SupportProgramDocumentException) {
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} format={} mimeType={} fileSize={} stage=PARSER errorCode={} rootException={}",
                        sourceCode, sourceProgramId, documentIndex, attachmentId(file.sourceUrl), file.fileName.take(250), file.format, file.mimeType, file.bytes.size, error.reason.name, error.javaClass.name)
                    if (error.reason !in setOf(
                            SupportProgramDocumentException.Reason.UNSUPPORTED,
                            SupportProgramDocumentException.Reason.TOO_LARGE,
                        )) throw error
                    hasExcludedDocument = true
                    if (error.reason == SupportProgramDocumentException.Reason.TOO_LARGE) excludedReason = Reason.SOURCE_TOO_LARGE
                    warnings.add("자동 분석 제외 첨부(SOURCE_${error.reason.name}): ${file.fileName.take(250)}")
                    return@mapIndexedNotNull null
                }
                logger.info("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} format={} mimeType={} fileSize={} stage=PARSED blockCount={} sourceLength={}",
                    sourceCode, sourceProgramId, documentIndex, attachmentId(file.sourceUrl), file.fileName.take(250), file.format, file.mimeType, file.bytes.size, blocks.size, blocks.sumOf { it.text.length })
                ApplicationFormDiscoveryDocument(
                    documentIndex,
                    file.sourceUrl,
                    file.fileName,
                    file.format,
                    file.bytes.size.toLong(),
                    sha256(file.bytes),
                    blocks.mapIndexed { blockIndex, block ->
                        ApplicationFormDiscoveryBlock("D$documentIndex-B$blockIndex", block.locator, block.text)
                    },
                    sourceBytes = file.bytes.takeIf { file.format == "HWPX" },
                )
            }
            val sourceLimit = 120_000
            val sizedDocuments = documents.filter { document ->
                val length = document.blocks.sumOf { it.text.length }
                if (length > sourceLimit) {
                    hasExcludedDocument = true
                    excludedReason = Reason.SOURCE_TOO_LARGE
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} format={} fileSize={} stage=SOURCE_LIMIT sourceLength={} limit={} errorCode=SOURCE_TOO_LARGE",
                        sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250), document.format, document.bytes, length, sourceLimit)
                    warnings.add("자동 분석 제외 첨부(SOURCE_TOO_LARGE): ${document.fileName.take(250)}")
                    false
                } else true
            }
            // 파일명이 위원용·공고문처럼 신청자가 채우지 않는 문서를 가리키면 유료 분석 전에 제외하고, 신청서로 보이는 문서를 먼저 분석합니다.
            // 판정으로 남는 문서가 없으면 판정을 무시하고 전부 분석합니다. 결과 없음은 NO_FORM이지 수집 실패가 아닙니다.
            val roles = sizedDocuments.associate { it.documentIndex to ApplicationAttachmentRole.classify(it.fileName) }
            val eligibleDocuments = sizedDocuments.filter { roles[it.documentIndex] != ApplicationAttachmentRole.NON_APPLICANT }
                .ifEmpty { sizedDocuments }
                .sortedBy { if (roles[it.documentIndex] == ApplicationAttachmentRole.APPLICANT) 0 else 1 }
            sizedDocuments.filter { it !in eligibleDocuments }.forEach { document ->
                logger.info("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=ROLE_FILTER role=NON_APPLICANT",
                    sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250))
                warnings.add("자동 분석 제외 첨부(NON_APPLICANT_ROLE): ${document.fileName.take(250)}")
            }
            if (eligibleDocuments.isEmpty()) throw ApplicationFormDiscoveryException(excludedReason)
            val input = ApplicationFormDiscoveryInput(
                sourceCode,
                sourceProgramId,
                collected.programTitle.ifBlank { catalogTitle },
                sourceUrl,
                eligibleDocuments,
            )
            var candidateFailure: Exception? = null
            beforeAi()
            // 문서마다 별도 OpenAI 호출이므로 몇 개씩 동시에 보냅니다. 결과와 첫 실패는 문서 순서대로 모읍니다.
            val outcomes = mapConcurrently(eligibleDocuments) { document ->
                try {
                    val candidates = ai.discover(input.copy(documents = listOf(document)), configuration)
                    logger.info("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=AI_ANALYSIS formCount={} model={}",
                        sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250), candidates.size, configuration.model)
                    CandidateOutcome(candidates)
                } catch (error: AiApplicationFormValidationException) {
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=AI_VALIDATION errorCode=AI_INVALID_RESPONSE",
                        sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250))
                    CandidateOutcome(failure = ApplicationFormDiscoveryException(Reason.AI_INVALID_RESPONSE, error))
                } catch (error: AiApplicationFormTooLargeException) {
                    // native 입력 대상 수 초과는 문서 자체의 크기 문제라 재시도나 검토 잠금 없이 이 첨부만 제외합니다.
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=AI_NATIVE_LIMIT errorCode=SOURCE_TOO_LARGE",
                        sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250))
                    CandidateOutcome(excluded = document)
                } catch (error: AiServiceCallException) {
                    if (error.failure.name != "INVALID_RESPONSE") throw error
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=CORE_RESPONSE_VALIDATION errorCode=AI_INVALID_RESPONSE",
                        sourceCode, sourceProgramId, document.documentIndex, attachmentId(document.sourceUrl), document.fileName.take(250))
                    CandidateOutcome(failure = error)
                }
            }
            outcomes.mapNotNull { it.excluded }.forEach { document ->
                hasExcludedDocument = true
                excludedReason = Reason.SOURCE_TOO_LARGE
                warnings.add("자동 분석 제외 첨부(NATIVE_TARGET_LIMIT): ${document.fileName.take(250)}")
            }
            candidateFailure = outcomes.firstNotNullOfOrNull { it.failure }
            val extracted = outcomes.flatMap { it.candidates }
            if (extracted.isEmpty()) throw candidateFailure ?: ApplicationFormDiscoveryException(if (hasExcludedDocument) excludedReason else Reason.NO_FORM)
            val forms = extracted.mapNotNull { candidate ->
                try {
                    val document = requireNotNull(documents.find { it.documentIndex == candidate.documentIndex })
                    val blockById = document.blocks.associateBy { it.blockId }
                    ApplicationFormManifest(
                        schemaVersion = 1,
                        formVersionId = formVersionId(
                            sourceCode, sourceProgramId, document.sha256, configuration.model, configuration.promptVersion, sourceFingerprint,
                        ),
                        sourceCode = sourceCode,
                        sourceProgramId = sourceProgramId,
                        programTitle = input.programTitle,
                        formTitle = document.fileName.replace(Regex("(?i)\\.(pdf|hwp|hwpx|docx|xlsx).*"), "").trim().take(300),
                        sourceUrl = input.programSourceUrl,
                        attachmentFileName = document.fileName,
                        attachmentBytes = document.bytes,
                        attachmentSha256 = document.sha256,
                        verificationStatus = "SOURCE_DOCUMENT_EXTRACTED",
                        institutionReviewed = false,
                        supportedServiceFields = listOf(ApplicationServiceField.GENERAL),
                        sections = candidate.sections.map { section ->
                            val locator = section.fields.map { field -> requireNotNull(blockById[field.evidenceBlockId]).locator }
                                .distinct().joinToString(", ").trim().take(200)
                            ApplicationFormSectionDefinition(
                                section.key,
                                section.title,
                                locator,
                                section.description,
                                section.fields.map { field ->
                                    ApplicationFormFieldDefinition(field.key, field.label, field.guidance, field.required, field.options)
                                },
                            )
                        },
                    )
                } catch (error: IllegalArgumentException) {
                    val document = documents.find { it.documentIndex == candidate.documentIndex }
                    val failure = AiServiceCallException.invalidResponse("Application form discovery output could not form a safe manifest", error)
                    if (candidateFailure == null) candidateFailure = failure
                    val optionDiagnostics = candidate.sections.flatMap { section -> section.fields.mapNotNull { field ->
                        field.options.takeIf { it.isNotEmpty() }?.let { options ->
                            "${section.key}:${field.key} count=${options.size} distinct=${options.distinct().size} " +
                                "controlCodePoints=${options.flatMap { option -> option.codePoints().toArray().toList() }.filter { Character.getType(it) in setOf(Character.CONTROL.toInt(), Character.FORMAT.toInt()) }.distinct()}"
                        }
                    } }.take(10)
                    logger.warn("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} stage=CORE_MODEL errorCode=AI_INVALID_RESPONSE rootException={} rootMessage={} optionDiagnostics={}",
                        sourceCode, sourceProgramId, candidate.documentIndex, document?.sourceUrl?.let(::attachmentId), document?.fileName?.take(250), error.javaClass.name, error.message?.take(500), optionDiagnostics, error)
                    null
                }
            }
            val bound = forms.mapNotNull { form ->
                try {
                    bindDocumentMaps(listOf(form), collected.files).single()
                } catch (error: ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException) {
                    val root = generateSequence(error as Throwable) { it.cause }.last()
                    // 양식을 찾고도 매핑에서 실패한 사실이 다른 문서의 추출 검증 실패보다 우선입니다. 재시도 가능 여부가 여기서 갈립니다.
                    if (candidateFailure == null || isRetryableDocumentFailure(error)) candidateFailure = error
                    val original = collected.files.find { sha256(it.bytes) == form.attachmentSha256 }
                    logger.error("application_form_candidate sourceCode={} sourceProgramId={} candidateIndex={} attachmentId={} filename={} sourceSha256={} fileSize={} stage=DOCUMENT_MAPPING errorCode={} rootException={} rootMessage={}",
                        sourceCode, sourceProgramId, documents.find { it.sha256 == form.attachmentSha256 }?.documentIndex,
                        original?.sourceUrl?.let(::attachmentId), form.attachmentFileName.take(250), form.attachmentSha256,
                        form.attachmentBytes, error.code, root.javaClass.name, root.message?.take(500), error)
                    null
                }
            }
            if (bound.isEmpty()) throw candidateFailure ?: ApplicationFormDiscoveryException(if (hasExcludedDocument) excludedReason else Reason.NO_FORM)
            if (persist != null) persist(bound, metadata)
            else snapshots.save(bound, sourceFingerprint, SupportProgramDocumentParser.VERSION, configuration)
            val storedForms = bound.map { form -> requireNotNull(snapshots.findByVersion(form.formVersionId)) }
            ApplicationFormDiscoveryResult(storedForms, warnings.distinct(), false)
        } catch (error: AiApplicationFormValidationException) {
            throw ApplicationFormDiscoveryException(Reason.AI_INVALID_RESPONSE, error)
        } catch (error: ApplicationFormDiscoveryException) {
            throw error
        } catch (error: SupportProgramDocumentException) {
            throw ApplicationFormDiscoveryException(
                when (error.reason) {
                    SupportProgramDocumentException.Reason.UNSUPPORTED -> Reason.SOURCE_UNSUPPORTED
                    SupportProgramDocumentException.Reason.NOT_FOUND -> Reason.SOURCE_NOT_FOUND
                    SupportProgramDocumentException.Reason.UNAVAILABLE -> Reason.SOURCE_UNAVAILABLE
                    SupportProgramDocumentException.Reason.INVALID -> Reason.SOURCE_INVALID
                    SupportProgramDocumentException.Reason.TOO_LARGE -> Reason.SOURCE_TOO_LARGE
                },
                error,
            )
        } catch (error: AiServiceCallException) {
            throw error
        } catch (error: IllegalArgumentException) {
            throw ApplicationFormDiscoveryException(Reason.SOURCE_INVALID, error)
        }
    }

    private fun bindDocumentMaps(forms: List<ApplicationFormManifest>, files: List<ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment>) = forms.map { form ->
        val original = files.firstOrNull { sha256(it.bytes) == form.attachmentSha256 }
            ?: throw ApplicationFormDiscoveryException(Reason.SOURCE_CHANGED)
        form.copy(documentMapSnapshot = documentMapping.ensure(form, original.bytes, original.format))
    }

    private fun attachmentId(sourceUrl: String): String? =
        Regex("(?:[?&])atchFileId=(FILE_[0-9]+)&fileSn=([0-9]+)").find(sourceUrl)?.let { "${it.groupValues[1]}:${it.groupValues[2]}" }

    private fun formVersionId(
        sourceCode: String,
        sourceProgramId: String,
        documentHash: String,
        model: String,
        promptVersion: String,
        sourceFingerprint: String,
    ): String {
        val versionHash = sha256(
            "$sourceFingerprint\u0000$documentHash\u0000${SupportProgramDocumentParser.VERSION}\u0000$model\u0000$promptVersion".toByteArray(),
        )
        val source = sourceCode.lowercase().replace('_', '-')
        val hash = versionHash.take(28)
        val program = sourceProgramId.lowercase().replace('_', '-')
            .take(160 - source.length - hash.length - 2)
        return "$source-$program-$hash"
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
