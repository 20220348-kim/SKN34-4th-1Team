package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentUnfilledAnswer
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import org.springframework.stereotype.Service
import java.security.MessageDigest

@Service
class ApplicationDocumentService(
    private val preparations: ApplicationPreparationService,
    private val redis: org.springframework.data.redis.core.StringRedisTemplate,
    private val files: ApplicationDocumentRepository,
    private val editor: ApplicationDocumentEditor,
    private val documentMapping: ApplicationDocumentMappingService,
    private val mcp: ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient,
    private val bizInfo: BizInfoAttachmentClient,
    private val msit: MsitAttachmentClient,
    private val kStartup: KStartupAttachmentClient,
    private val cnTrade: CnTradeNoticeAttachmentClient,
    private val details: SupportProgramDetailService,
    private val admission: SupportProgramRequestAdmissionService,
    private val availability: ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository,
    private val json: tools.jackson.databind.ObjectMapper,
) {
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun fingerprint(source: String, revision: Long, pipeline: String) = sha256("$source:$revision:$pipeline:partial-draft-v1".toByteArray(Charsets.UTF_8))
    private val running = java.util.concurrent.ConcurrentHashMap.newKeySet<Long>()
    fun current(account: Account, id: Long): List<ApplicationDocumentFile> {
        preparations.findOwned(account, id)
        return files.listOwned(account.id, id)
    }

    fun download(account: Account, id: Long, fileId: Long): ApplicationDocumentFile =
        files.findOwned(account.id, id, fileId) ?: throw ApplicationPreparationNotFoundException()

    fun generate(account: Account, id: Long, expectedRevision: Long): List<ApplicationDocumentFile> = admission.execute("application-document:${account.id}:$id") {
        val detail = preparations.findOwned(account, id)
        if (detail.preparation.inputRevision != expectedRevision) throw ApplicationPreparationRevisionConflictException()
        val pipelineVersion = mcp.configuration().pipelineVersion
        val fingerprint = fingerprint(detail.form.attachmentSha256, expectedRevision, pipelineVersion)
        files.findFingerprint(account.id, id, expectedRevision, fingerprint)?.let { return@execute listOf(it) }
        if (!running.add(id)) throw ApplicationPreparationRunConflictException()
        val lockKey = "application-document-run:$id"
        val lockToken = java.util.UUID.randomUUID().toString()
        var acquired = false
        var outcomeUnknown = false
        try {
        acquired = redis.opsForValue().setIfAbsent(lockKey, lockToken, java.time.Duration.ofMinutes(15)) == true
        if (!acquired) throw ApplicationPreparationRunConflictException()
        val manifest = detail.form
        val facts = manifest.sections.flatMap { section -> section.fields.mapNotNull { field ->
            val fact = detail.facts.find { it.sectionKey == section.key && it.fieldKey == field.key }
            if (fact == null) {
                if (field.required) throw ApplicationDocumentException("APPLICATION_DOCUMENT_INPUT_REQUIRED", "필수 답변을 저장한 뒤 문서를 생성해 주세요.")
                null
            } else if (fact.status.name == "UNKNOWN") null
            else ApplicationDocumentFact("${section.key}:${field.key}", "${section.title} / ${field.label}", requireNotNull(fact.value))
        } }
        if (facts.isEmpty() || facts.size > 200) throw ApplicationDocumentException("APPLICATION_DOCUMENT_INPUT_REQUIRED", "문서에 기입할 답변을 확인해 주세요.")
        val collected = try { when (manifest.sourceCode) {
            "BIZINFO" -> bizInfo.collect(manifest.sourceCode, manifest.sourceProgramId)
            "MSIT" -> msit.collect(manifest.sourceCode, manifest.sourceProgramId, manifest.sourceUrl)
            "KSTARTUP" -> kStartup.collect(manifest.sourceCode, manifest.sourceProgramId, manifest.sourceUrl)
            "CNTRADE_NOTICE" -> {
                val program = details.get(manifest.sourceCode, manifest.sourceProgramId)
                cnTrade.collect(manifest.sourceCode, manifest.sourceProgramId, program.title, program.targetDescription)
            }
            else -> throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNSUPPORTED", "원본 첨부를 확보할 수 없는 제공처입니다.")
        }
        } catch (error: ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException) {
            availability.stale(manifest.sourceCode, manifest.sourceProgramId, "SOURCE_NOT_FOUND")
            throw error
        } catch (error: ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException) {
            availability.stale(manifest.sourceCode, manifest.sourceProgramId, "DOCUMENT_${error.reason.name}")
            throw error
        }
        val original = collected.files.find { MessageDigest.getInstance("SHA-256").digest(it.bytes).joinToString("") { b -> "%02x".format(b) } == manifest.attachmentSha256 }
            ?: run {
                availability.stale(manifest.sourceCode, manifest.sourceProgramId, "ATTACHMENT_HASH_CHANGED_OR_MISSING")
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_SOURCE_CHANGED", "공식 첨부가 변경되었거나 없어졌습니다. 재분석 완료 후 새 작성을 시작해 주세요.")
        }
        val binding = documentMapping.ensure(manifest, original.bytes, original.format)
        val mappedFactIds = binding.bindings.map { it.factId }.toSet()
        val writableFacts = facts.filter { it.id in mappedFactIds }
        val unfilledAnswers = facts.filterNot { it.id in mappedFactIds }.map {
            ApplicationDocumentUnfilledAnswer(it.id, it.label, it.value, "INPUT_LOCATION_NOT_FOUND")
        }
        if (writableFacts.isEmpty())
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_NO_WRITABLE_INPUT", "자동 기입할 수 있는 답변이 없어 초안을 생성하지 않았습니다. 원본 문서에서 직접 작성해 주세요.")
        val writableFactIds = writableFacts.map(ApplicationDocumentFact::id).toSet()
        val writableBindings = binding.bindings.filter { it.factId in writableFactIds }
        val inspection = if (original.format.lowercase() in setOf("pdf", "hwp")) editor.inspect(original.bytes, original.format) else null
        val result = mcp.generate(ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationRequest(
            sourceBase64 = java.util.Base64.getEncoder().encodeToString(original.bytes),
            sourceSha256 = manifest.attachmentSha256, format = original.format.lowercase(),
            answerRevision = expectedRevision, facts = writableFacts,
            scope = (manifest.formTitle + "\n" + manifest.sections.joinToString("\n") { "${it.key}: ${it.title} | ${it.locator} | ${it.description}" }).take(30000),
            pdfTargets = if (original.format.equals("pdf", true)) inspection?.targets.orEmpty() else emptyList(),
            hwpTargets = if (original.format.equals("hwp", true)) inspection?.targets.orEmpty() else emptyList(),
            pageImages = inspection?.pageImages.orEmpty(),
            bindings = writableBindings, scopeTargetIds = binding.scopeTargetIds, pdfFields = inspection?.pdfFields.orEmpty(),
        ))
        val output = try { java.util.Base64.getDecoder().decode(result.outputBase64) } catch (_: IllegalArgumentException) {
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "문서 결과의 형식을 확인하지 못했습니다.")
        }
        if (result.contractVersion != "application-document-mcp-v1" || result.pipelineVersion != pipelineVersion ||
            result.sourceSha256 != manifest.attachmentSha256 || result.answerRevision != expectedRevision ||
            output.size !in 1..32 * 1024 * 1024 || sha256(output) != result.outputSha256 ||
            !Regex("[a-f0-9]{64}").matches(result.planHash)) {
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "원본·입력 버전과 문서 결과가 일치하지 않습니다.")
        }
        val bytes = if (original.format.equals("hwp", true)) {
            if (result.verification["stage"] != "HWPLIB_REQUIRED" || !output.contentEquals(original.bytes))
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "HWP 원본과 편집 처리 순서가 일치하지 않습니다.")
            val plan = try { json.convertValue(result.writePlan, ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentWritePlan::class.java) }
            catch (error: IllegalArgumentException) { throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "HWP 편집 계획을 확인하지 못했습니다.", error) }
            fun canonical(value: Any?): Any? = when (value) {
                is Map<*, *> -> value.entries.associate { it.key.toString() to canonical(it.value) }.toSortedMap()
                is List<*> -> value.map(::canonical)
                else -> value
            }
            if (plan.sourceSha256 != manifest.attachmentSha256 || plan.answerRevision != expectedRevision ||
                plan.mapVersion != result.mapVersion || plan.mapVersion != binding.mapVersion || plan.planHash != result.planHash ||
                result.placements.toSet() != plan.operations.filter { it.valueRef != null }.map { ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement(it.valueRef!!, it.targetId) }.toSet() ||
                sha256(json.writeValueAsBytes(canonical(result.writePlan.filterKeys { it != "planHash" }))) != result.planHash)
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "HWP 편집 계획의 원본·버전·해시가 일치하지 않습니다.")
            editor.applyHwpPlan(original.bytes, writableFacts, plan, writableBindings, binding.scopeTargetIds)
        } else if (original.format.equals("pdf", true)) {
            if (result.verification["stage"] != "PDFBOX_REQUIRED") throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "PDF 처리 순서가 일치하지 않습니다.")
            editor.fill(output, "pdf", writableFacts, result.placements)
        } else output
        val format = original.format.lowercase()
        val fileName = manifest.attachmentFileName.replace(Regex("(?i)\\.(hwp|hwpx|pdf).*$"), "").replace(Regex("[\\\\/:*?\"<>|]"), "_").take(430) + "_초안_v$expectedRevision.$format"
        val mediaType = when (format) { "pdf" -> "application/pdf"; "hwpx" -> "application/hwp+zip"; else -> "application/x-hwp" }
        val verification = if (format == "hwp") result.verification + mapOf("stage" to "HWPLIB_VERIFIED", "reopened" to true, "outputSha256" to sha256(bytes), "render" to "NOT_RUN") else result.verification
        listOf(files.save(account.id, id, expectedRevision, fileName, mediaType, bytes, manifest.attachmentSha256, result.placements,
            fingerprint = fingerprint,
            evidence = mapOf("documentMap" to result.documentMap, "writePlan" to result.writePlan, "verification" to verification, "pipelineVersion" to result.pipelineVersion),
            filledAnswerCount = writableFacts.size,
            unfilledAnswers = unfilledAnswers))
        } catch (error: ApplicationDocumentException) {
            if (error.code == "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN") {
                outcomeUnknown = true
                redis.persist(lockKey)
            }
            throw error
        } finally {
            if (acquired && !outcomeUnknown) {
                val script = org.springframework.data.redis.core.script.DefaultRedisScript<Long>("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", Long::class.java)
                redis.execute(script, listOf(lockKey), lockToken)
            }
            running.remove(id)
        }
    }
}
