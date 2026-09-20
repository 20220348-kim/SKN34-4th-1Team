package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.client.ai.exception.AiApplicationFormValidationException
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
import ai.govbiz.core.applicationpreparation.facade.AiApplicationPreparationFacade
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
    private val transactions = org.springframework.transaction.support.TransactionTemplate(transactionManager)
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
        val lease = availability.claimRequested(sourceCode, sourceProgramId)
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
            if (lease != null) availability.finish(lease,
                ApplicationFormAvailabilityStatus.REVIEW_REQUIRED,
                "MANUAL_REANALYSIS_FAILED", cacheResult = false)
            throw error
        }
    }

    /** 시스템 작업과 백필은 계정별 discovery job을 사용하지 않으며 저장 transaction을 호출자가 소유한다. */
    fun analyzeSystem(
        sourceCode: String, sourceProgramId: String,
        configuration: ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration,
        observe: (ApplicationFormAnalysisMetadata) -> Unit,
        beforeAi: () -> Unit,
        persist: (List<ApplicationFormManifest>, ApplicationFormAnalysisMetadata) -> Unit,
        recordedPayload: ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload? = null,
        expectedFiles: List<Pair<String, String>>? = null,
    ): ApplicationFormDiscoveryResult {
        validateIdentity(sourceCode, sourceProgramId)
        val program = details.get(sourceCode, sourceProgramId)
        return discoverFresh(sourceCode, sourceProgramId, program.title, program.targetDescription, program.sourceUrl,
            configuration, beforeAi, observe, persist, recordedPayload, expectedFiles)
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
        recordedPayload: ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload? = null,
        expectedFiles: List<Pair<String, String>>? = null,
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
            if (expectedFiles != null && collected.files.map { it.sourceUrl to sha256(it.bytes) } != expectedFiles) {
                throw ApplicationFormDiscoveryException(Reason.SOURCE_CHANGED)
            }
            observe(metadata)
            snapshots.findByProgram(
                sourceCode, sourceProgramId, sourceFingerprint, SupportProgramDocumentParser.VERSION,
                configuration.model, configuration.promptVersion,
            )
                .takeIf { it.isNotEmpty() }?.let { cached ->
                    val bound = if (recordedPayload == null) bindDocumentMaps(cached, collected.files) else cached
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
                    if (error.reason !in setOf(
                            SupportProgramDocumentException.Reason.UNSUPPORTED,
                            SupportProgramDocumentException.Reason.TOO_LARGE,
                        )) throw error
                    hasExcludedDocument = true
                    if (error.reason == SupportProgramDocumentException.Reason.TOO_LARGE) excludedReason = Reason.SOURCE_TOO_LARGE
                    warnings.add("자동 분석 제외 첨부(SOURCE_${error.reason.name}): ${file.fileName.take(250)}")
                    return@mapIndexedNotNull null
                }
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
            if (documents.isEmpty()) throw ApplicationFormDiscoveryException(excludedReason)
            if (documents.sumOf { document -> document.blocks.sumOf { it.text.length } } > 120_000) {
                throw ApplicationFormDiscoveryException(Reason.SOURCE_TOO_LARGE)
            }
            val input = ApplicationFormDiscoveryInput(
                sourceCode,
                sourceProgramId,
                collected.programTitle.ifBlank { catalogTitle },
                sourceUrl,
                documents,
            )
            val extracted = if (recordedPayload != null) ai.validateDiscoveryPayload(input, configuration, recordedPayload)
                else { beforeAi(); ai.discover(input, configuration) }
            if (extracted.isEmpty()) throw ApplicationFormDiscoveryException(if (hasExcludedDocument) excludedReason else Reason.NO_FORM)
            val forms = try {
                extracted.map { candidate ->
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
                        formTitle = document.fileName.replace(Regex("(?i)\\.(pdf|hwp|hwpx).*"), "").trim().take(300),
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
                }
            } catch (error: IllegalArgumentException) {
                throw AiServiceCallException.invalidResponse("Application form discovery output could not form a safe manifest", error)
            }
            val bound = if (recordedPayload == null) bindDocumentMaps(forms, collected.files) else forms
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
