package ai.govbiz.core.applicationpreparation.service.backfill

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import ai.govbiz.core.applicationpreparation.service.ApplicationFormDiscoveryService
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload
import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper
import java.nio.file.Path
import java.security.MessageDigest

@Service
class ApplicationFormBackfillService(
    private val json: ObjectMapper,
    private val availability: ApplicationFormAvailabilityRepository,
    private val discovery: ApplicationFormDiscoveryService,
    private val catalog: ai.govbiz.core.supportprogram.repository.SupportProgramRepository,
    transactionManager: org.springframework.transaction.PlatformTransactionManager,
) {
    private val transactions = org.springframework.transaction.support.TransactionTemplate(transactionManager)
    data class Result(val input: ApplicationFormBackfillInput.Report, val skipped: Int, val statusCounts: Map<String, Int>, val availablePrograms: Int, val snapshotCount: Int)
    fun apply(path: Path, expectedHash: String): Result = applyValidated(ApplicationFormBackfillInput(json).read(path, expectedHash))

    internal fun applyValidated(input: ApplicationFormBackfillInput.Validated): Result {
        var skipped = 0
        input.programs.forEach { program ->
            val source = program.path("sourceCode").asString(); val id = program.path("sourceProgramId").asString()
            val currentProgram = catalog.findPresentBySourceAndProgramId(source, id)
            val catalogFingerprint = currentProgram?.let {
                ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper.calculate(listOf(it))
            } ?: input.report.sha256 // 없는 공고는 활성화하지 않으며, 최초 공고 동기화가 이 표식을 대체한다.
            val lease = availability.claimImport(source, id, input.report.sha256, catalogFingerprint)
            if (lease == null) { skipped++; return@forEach }
            val analysis = program.path("aiAnalysis")
            val configuration = ApplicationFormDiscoveryConfiguration(analysis.path("contractVersion").asString(), analysis.path("model").asString(), analysis.path("promptVersion").asString())
            val files = program.path("files").toList().map { it.path("sourceUrl").asString() to it.path("sha256").asString() }
            val fingerprint = MessageDigest.getInstance("SHA-256").digest(program.path("files").joinToString("\n") {
                "${it.path("sourceUrl").asString()}\u0000${it.path("fileName").asString()}\u0000${it.path("sha256").asString()}"
            }.toByteArray()).joinToString("") { "%02x".format(it) }
            availability.observe(lease, ApplicationFormAnalysisMetadata(fingerprint, configuration, SupportProgramDocumentParser.VERSION))
            val hash = input.report.sha256
            when (analysis.path("status").asString()) {
                "FORM_FOUND" -> try {
                    val payload = AiApplicationFormDiscoveryPayload(configuration.contractVersion, configuration.model, configuration.promptVersion,
                        analysis.path("forms").toList().map { json.treeToValue(it, ai.govbiz.core.applicationpreparation.client.ai.dto.AiDiscoveredApplicationFormPayload::class.java) })
                    discovery.analyzeSystem(source, id, configuration, {},
                        { error("OpenAI is forbidden during backfill") },
                        { forms, metadata -> transactions.executeWithoutResult { availability.available(lease, forms, metadata, hash) } }, payload, files)
                } catch (error: ApplicationFormDiscoveryException) {
                    val status = when (error.reason.name) {
                        "SOURCE_CHANGED" -> ApplicationFormAvailabilityStatus.STALE
                        "SOURCE_TOO_LARGE" -> ApplicationFormAvailabilityStatus.TOO_LARGE
                        "SOURCE_UNAVAILABLE" -> ApplicationFormAvailabilityStatus.RETRY_WAITING
                        "SOURCE_NOT_FOUND", "SOURCE_UNSUPPORTED", "SOURCE_INVALID" -> ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE
                        else -> ApplicationFormAvailabilityStatus.REVIEW_REQUIRED
                    }
                    availability.finish(lease, status, error.reason.name, status == ApplicationFormAvailabilityStatus.RETRY_WAITING, hash)
                } catch (_: ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException) {
                    availability.finish(lease, ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE, "SOURCE_NOT_FOUND", importHash=hash)
                } catch (_: AiServiceCallException) {
                    availability.finish(lease, ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, "BACKFILL_CONTRACT_INVALID", importHash=hash)
                } catch (_: IllegalArgumentException) {
                    availability.finish(lease, ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, "BACKFILL_MANIFEST_INVALID", importHash=hash)
                }
                "NO_FORM" -> availability.finish(lease, ApplicationFormAvailabilityStatus.NO_FORM, "NO_FORM", importHash=hash)
                "NOT_ELIGIBLE" -> {
                    val reasons = program.path("failureCodes").toList().map { it.asString() }
                    val reason = reasons.joinToString(";").ifBlank { "COLLECTION:${analysis.path("failure").path("kind").asString()}" }.take(200)
                    val status = when {
                        reason.contains("TOO_LARGE") -> ApplicationFormAvailabilityStatus.TOO_LARGE
                        reason.contains("UNAVAILABLE") || reason.contains("TIMEOUT") -> ApplicationFormAvailabilityStatus.RETRY_WAITING
                        reason.contains("UNSUPPORTED") || reason.contains("NOT_FOUND") || reason.contains("INVALID") -> ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE
                        else -> ApplicationFormAvailabilityStatus.REVIEW_REQUIRED
                    }
                    availability.finish(lease, status, reason, status == ApplicationFormAvailabilityStatus.RETRY_WAITING, hash)
                }
                "FAILED" -> {
                    val failure = analysis.path("failure")
                    val code = failure.path("code").asString(failure.path("kind").asString("UNKNOWN"))
                    val retry = code !in setOf("APPLICATION_PREPARATION_FAILED", "APPLICATION_FORM_AI_INVALID_RESPONSE") &&
                        (failure.path("status").asInt() in setOf(429, 503, 504) || code.contains("TIMEOUT"))
                    availability.finish(lease, if (retry) ApplicationFormAvailabilityStatus.RETRY_WAITING else ApplicationFormAvailabilityStatus.REVIEW_REQUIRED,
                        code.take(200), retry, hash)
                }
                else -> availability.finish(lease, ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, "UNKNOWN_AFTER_START", importHash=hash)
            }
        }
        val states = input.programs.map { requireNotNull(availability.find(it.path("sourceCode").asString(), it.path("sourceProgramId").asString())) }
        val counts = states.groupingBy { it.status.name }.eachCount().toSortedMap()
        val snapshots = states.sumOf { availability.activeForms(it.sourceCode, it.sourceProgramId).size }
        return Result(input.report, skipped, counts, counts["AVAILABLE"] ?: 0, snapshots)
    }
}
