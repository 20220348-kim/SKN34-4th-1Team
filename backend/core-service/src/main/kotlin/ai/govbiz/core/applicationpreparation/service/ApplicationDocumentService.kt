package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentSkippedFact
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentUnfilledAnswer
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.fieldMappings
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationConfirmedResult
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRevisionConflictException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentRepository
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentMigrationRepository
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationDocumentMcpException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentMappingChangedException
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentArchiveResult
import ai.govbiz.core.planusage.service.PlanUsageService
import org.springframework.stereotype.Service
import java.security.MessageDigest

@Service
class ApplicationDocumentService(
    private val preparations: ApplicationPreparationService,
    private val redis: org.springframework.data.redis.core.StringRedisTemplate,
    private val files: ApplicationDocumentRepository,
    private val editor: ApplicationDocumentEditor,
    private val documentMapping: ApplicationDocumentMappingService,
    private val migrationProposals: ApplicationDocumentMigrationProposalStore,
    private val migrations: ApplicationDocumentMigrationRepository,
    private val mcp: ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient,
    private val bizInfo: BizInfoAttachmentClient,
    private val msit: MsitAttachmentClient,
    private val kStartup: KStartupAttachmentClient,
    private val cnTrade: CnTradeNoticeAttachmentClient,
    private val details: SupportProgramDetailService,
    private val admission: SupportProgramRequestAdmissionService,
    private val planUsage: PlanUsageService,
    private val availability: ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository,
    private val json: tools.jackson.databind.ObjectMapper,
    @param:org.springframework.beans.factory.annotation.Value("\${app.application-document.unknown-outcome-lock-ttl:PT24H}")
    private val unknownOutcomeLockTtl: java.time.Duration,
) {
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun fingerprint(source: String, revision: Long, pipeline: String, engine: String? = null) =
        sha256("$source:$revision:$pipeline${engine?.let { ":$it" }.orEmpty()}:partial-draft-v1".toByteArray(Charsets.UTF_8))
    private val running = java.util.concurrent.ConcurrentHashMap.newKeySet<Long>()
    fun current(account: Account, id: Long): List<ApplicationDocumentFile> {
        preparations.findOwned(account, id)
        return files.listOwned(account.id, id)
    }

    fun download(account: Account, id: Long, fileId: Long): ApplicationDocumentFile =
        files.findOwned(account.id, id, fileId) ?: throw ApplicationPreparationNotFoundException()

    /** 답변 버전 하나의 파일을 묶는다. 저장된 LONGBLOB만 읽으며 새 파일을 저장하지 않는다. */
    fun archive(account: Account, id: Long, revision: Long): ApplicationDocumentArchiveResult {
        preparations.findOwned(account, id)
        val matching = files.listOwned(account.id, id).filter { it.inputRevision == revision }.sortedBy { it.id }
        if (matching.isEmpty()) throw ApplicationPreparationNotFoundException()
        matching.singleOrNull()?.let { return ApplicationDocumentArchiveResult(it.fileName, it.mediaType, it.bytes, 1) }
        val output = java.io.ByteArrayOutputStream()
        java.util.zip.ZipOutputStream(output, Charsets.UTF_8).use { zip ->
            val used = mutableSetOf<String>()
            for (file in matching) {
                var name = file.fileName
                var suffix = 2
                while (!used.add(name)) {
                    name = file.fileName.replaceFirst(Regex("(\\.[^.]+)?$"), "_$suffix$1")
                    suffix += 1
                }
                zip.putNextEntry(java.util.zip.ZipEntry(name))
                zip.write(file.bytes)
                zip.closeEntry()
            }
        }
        return ApplicationDocumentArchiveResult("신청문서_초안_v$revision.zip", "application/zip", output.toByteArray(), matching.size)
    }

    fun confirmMigration(account: Account, id: Long, expectedRevision: Long,
                         approvalToken: String): ApplicationDocumentMigrationConfirmedResult {
        fun stale(): Nothing = throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE",
            "답변·원본 또는 문서 분석 버전이 변경됐습니다. 변경 내용을 다시 확인해 주세요.")
        val detail = preparations.findOwned(account, id)
        val proposal = migrationProposals.read(account.id, id, approvalToken)
        val configuration = callMcp { mcp.configuration() }
        if (expectedRevision != proposal.expectedRevision || detail.preparation.inputRevision != expectedRevision ||
            detail.preparation.draft.formVersionId != proposal.oldFormVersionId ||
            detail.form.attachmentSha256 != proposal.sourceSha256 ||
            configuration.pipelineVersion != proposal.proposed.pipelineVersion ||
            (detail.form.attachmentFileName.substringAfterLast('.').lowercase() in setOf("docx", "xlsx") &&
                configuration.engineVersions[detail.form.attachmentFileName.substringAfterLast('.').lowercase()] != proposal.proposed.engineVersion)) stale()
        val currentSource = try { loadOriginal(detail.form).bytes } catch (error: ApplicationDocumentException) {
            if (error.code == "APPLICATION_DOCUMENT_SOURCE_CHANGED") stale()
            throw error
        }
        if (sha256(currentSource) != proposal.sourceSha256) stale()
        val newVersion = migrations.approve(proposal)
            ?: throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_MIGRATION_STALE",
                "확인 중 답변 또는 양식이 변경됐습니다. 변경 내용을 다시 확인해 주세요.")
        return ApplicationDocumentMigrationConfirmedResult(preparationId = id,
            inputRevision = expectedRevision, formVersionId = newVersion)
    }

    fun loadOriginal(manifest: ApplicationFormManifest): SupportProgramAttachment {
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
        return collected.files.find { sha256(it.bytes) == manifest.attachmentSha256 }
            ?: run {
                availability.stale(manifest.sourceCode, manifest.sourceProgramId, "ATTACHMENT_HASH_CHANGED_OR_MISSING")
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_SOURCE_CHANGED", "공식 첨부가 변경되었거나 없어졌습니다. 재분석 완료 후 새 작성을 시작해 주세요.")
            }
    }

    /**
     * 작업 표를 쓰지 않는 이전 동기 생성 경로다. 요청량 제한을 거친 뒤 [generateNow]를 실행한다. 클라이언트는 생성 작업을 쓰지만,
     * 이 경로도 AI 전에 그 공고를 신청 문서 월 한도에 기록하고 생성이 실패하면 돌려준다.
     */
    fun generate(account: Account, id: Long, expectedRevision: Long): List<ApplicationDocumentFile> =
        admission.execute("application-document:${account.id}:$id") {
            val draft = preparations.findOwned(account, id).preparation.draft
            planUsage.consumeDraftProgram(account.id, draft.sourceCode, draft.sourceProgramId) { generateNow(account, id, expectedRevision) }
        }

    /**
     * 실제 생성 흐름. 생성 작업(job)은 이 함수를 배경 실행 슬롯에서 호출하고 [onStage]로 단계를 기록한다.
     * [onAiStart]는 최초 매핑 또는 답변 기입 AI 요청 직전에 한 번 불린다. 그 뒤의 알 수 없는 실패는 결과 불명으로 분류한다.
     */
    fun generateNow(
        account: Account, id: Long, expectedRevision: Long,
        onStage: (ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage) -> Unit = {},
        onAiStart: () -> Unit = {},
    ): List<ApplicationDocumentFile> {
        val detail = preparations.findOwned(account, id)
        if (detail.preparation.inputRevision != expectedRevision) throw ApplicationPreparationRevisionConflictException()
        var aiStarted = false
        fun beginAiOnce() {
            if (!aiStarted) {
                onAiStart()
                aiStarted = true
            }
        }
        val configuration = callMcp { mcp.configuration() }
        val pipelineVersion = configuration.pipelineVersion
        val nativeFormat = detail.form.attachmentFileName.substringAfterLast('.').lowercase().takeIf { it in setOf("docx", "xlsx") }
        val docxEngine = nativeFormat?.let { configuration.engineVersions[it]
            ?: throw ApplicationDocumentException("APPLICATION_DOCUMENT_MCP_NOT_READY", "${it.uppercase()} 편집기 버전을 확인하지 못했습니다.") }
        val fingerprint = fingerprint(detail.form.attachmentSha256, expectedRevision, pipelineVersion, docxEngine)
        files.findFingerprint(account.id, id, expectedRevision, fingerprint)?.let { return listOf(it) }
        if (!running.add(id)) throw ApplicationPreparationRunConflictException()
        val lockKey = "application-document-run:$id"
        val lockToken = java.util.UUID.randomUUID().toString()
        var acquired = false
        var outcomeUnknown = false
        try {
        acquired = redis.opsForValue().setIfAbsent(lockKey, lockToken, java.time.Duration.ofMinutes(15)) == true
        if (!acquired) throw ApplicationPreparationRunConflictException()
        val manifest = detail.form
        // 비어 있는 질문은 필수 여부와 관계없이 건너뛴다. 초안은 저장된 답변만 기입하고 나머지 칸은 원본 그대로 둔다.
        val facts = manifest.sections.flatMap { section -> section.fields.mapNotNull { field ->
            val fact = detail.facts.find { it.sectionKey == section.key && it.fieldKey == field.key }
            if (fact == null || fact.status.name == "UNKNOWN") null
            else ApplicationDocumentFact("${section.key}:${field.key}", "${section.title} / ${field.label}", requireNotNull(fact.value))
        } }
        if (facts.size > 200) throw ApplicationDocumentException("APPLICATION_DOCUMENT_INPUT_REQUIRED", "문서에 기입할 답변을 확인해 주세요.")
        val original = loadOriginal(manifest)
        if (facts.isEmpty()) {
            // 저장된 답변이 하나도 없으면 기입할 것이 없으므로 입력 위치 분석과 AI 호출 없이 공식 원본을 0개 기입 초안으로 저장한다.
            val format = original.format.lowercase()
            onStage(ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage.SAVING)
            return listOf(files.save(account.id, id, expectedRevision, draftFileName(manifest.attachmentFileName, expectedRevision, format),
                draftMediaType(format), original.bytes, manifest.attachmentSha256, emptyList(), fingerprint = fingerprint,
                evidence = mapOf("verification" to mapOf("stage" to "ORIGINAL_WITHOUT_ANSWERS"), "pipelineVersion" to pipelineVersion),
                filledAnswerCount = 0, unfilledAnswers = emptyList()))
        }
        onStage(ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage.MAPPING)
        val binding = try {
            documentMapping.ensure(manifest, original.bytes, original.format, captureChange = true, onAiStart = ::beginAiOnce)
        } catch (changed: ApplicationDocumentMappingChangedException) {
            val notice = migrationProposals.create(account.id, id, expectedRevision, manifest, changed)
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED",
                "입력 위치가 변경됐습니다. 변경 내용을 확인한 뒤 적용할 수 있습니다. 저장된 답변과 파일은 유지됩니다.",
                mappingMigration = notice)
        }
        // 넣을 칸을 찾지 못한 답변은 필수 여부와 관계없이 미기입 목록으로 알리고, 칸이 확인된 답변만 기입한다.
        val fieldMappings = manifest.fieldMappings(binding)
        val mappedFactIds = fieldMappings.filter { it.writable }.map { it.fieldId }.toSet()
        val writableFacts = facts.filter { it.id in mappedFactIds }
        val unfilledAnswers = facts.filterNot { it.id in mappedFactIds }.map {
            ApplicationDocumentUnfilledAnswer(it.id, it.label, it.value, "INPUT_LOCATION_NOT_FOUND")
        }
        if (writableFacts.isEmpty())
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_NO_WRITABLE_INPUT", "자동 기입할 수 있는 답변이 없어 초안을 생성하지 않았습니다. 원본 문서에서 직접 작성해 주세요.")
        val writableFactIds = writableFacts.map(ApplicationDocumentFact::id).toSet()
        val writableBindings = binding.bindings.filter { it.factId in writableFactIds }
        val inspection = if (original.format.lowercase() in setOf("pdf", "hwp")) editor.inspect(original.bytes, original.format) else null
        onStage(ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage.WRITING)
        beginAiOnce()
        val result = callMcp { mcp.generate(ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationRequest(
            sourceBase64 = java.util.Base64.getEncoder().encodeToString(original.bytes),
            sourceSha256 = manifest.attachmentSha256, format = original.format.lowercase(),
            answerRevision = expectedRevision, facts = writableFacts,
            scope = (manifest.formTitle + "\n" + manifest.sections.joinToString("\n") { "${it.key}: ${it.title} | ${it.locator} | ${it.description}" }).take(30000),
            pdfTargets = if (original.format.equals("pdf", true)) inspection?.targets.orEmpty() else emptyList(),
            hwpTargets = if (original.format.equals("hwp", true)) inspection?.targets.orEmpty() else emptyList(),
            pageImages = inspection?.pageImages.orEmpty(),
            bindings = writableBindings, scopeTargetIds = binding.scopeTargetIds, pdfFields = inspection?.pdfFields.orEmpty(),
        )) }
        val output = try { java.util.Base64.getDecoder().decode(result.outputBase64) } catch (_: IllegalArgumentException) {
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "문서 결과의 형식을 확인하지 못했습니다.")
        }
        if (result.contractVersion != "application-document-mcp-v1" || result.pipelineVersion != pipelineVersion ||
            result.sourceSha256 != manifest.attachmentSha256 || result.answerRevision != expectedRevision ||
            output.size !in 1..32 * 1024 * 1024 || sha256(output) != result.outputSha256 ||
            !Regex("[a-f0-9]{64}").matches(result.planHash)) {
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "원본·입력 버전과 문서 결과가 일치하지 않습니다.")
        }
        if (original.format.lowercase() in setOf("docx", "xlsx") && (result.mapVersion != binding.mapVersion ||
                result.engineVersion != binding.engineVersion || result.verification["reopened"] != true ||
                result.verification["xml"] != "PASSED" || result.verification["styleStructure"] != "PASSED"))
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "${original.format.uppercase()} 원본 주소와 재열기 검증 결과가 일치하지 않습니다.")
        if (original.format.equals("xlsx", true) && (result.verification["formulas"] != "PASSED" ||
                result.verification["dataValidation"] != "PASSED" || result.verification["unchangedParts"] != "PASSED"))
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "XLSX 수식·검증 규칙 보존 결과를 확인하지 못했습니다.")
        // 칸에 맞지 않거나 쓸 빈칸을 정할 수 없어 남긴 답은 나머지 답으로 만든 초안과 함께 미기입 목록으로 알립니다.
        val skipped = result.skippedFacts.toMutableList()
        if (skipped.map { it.factId }.distinct().size != skipped.size || skipped.size >= writableFacts.size ||
            skipped.any { it.factId !in writableFactIds || it.reason !in ApplicationDocumentSkippedFact.REASONS })
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "문서 결과의 미기입 답변 목록을 확인하지 못했습니다.")
        if (result.remainingExampleCount !in 0..3000)
            throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "문서 결과의 남은 예시 칸 수를 확인하지 못했습니다.")
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
                plan.skippedFacts.toSet() != skipped.toSet() ||
                result.placements.toSet() != plan.operations.filter { it.valueRef != null }.map { ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement(it.valueRef!!, it.targetId) }.toSet() ||
                sha256(json.writeValueAsBytes(canonical(result.writePlan.filterKeys { it != "planHash" }))) != result.planHash)
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "HWP 편집 계획의 원본·버전·해시가 일치하지 않습니다.")
            editor.applyHwpPlan(original.bytes, writableFacts, plan, writableBindings, binding.scopeTargetIds)
        } else if (original.format.equals("pdf", true)) {
            if (result.verification["stage"] != "PDFBOX_REQUIRED") throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "PDF 처리 순서가 일치하지 않습니다.")
            val skippedIds = skipped.map { it.factId }.toSet()
            val (filled, overflow) = editor.fillPdfFitting(output, writableFacts.filter { it.id !in skippedIds }, result.placements)
            overflow.forEach { (factId, capacity) -> skipped += ApplicationDocumentSkippedFact(factId, reason = "OVERFLOW", capacity = capacity) }
            filled
        } else output
        val unfilled = unfilledAnswers + skipped.map { item ->
            val fact = writableFacts.single { it.id == item.factId }
            ApplicationDocumentUnfilledAnswer(fact.id, fact.label, fact.value,
                if (item.reason == "UNRESOLVED") "INPUT_LOCATION_NOT_FOUND" else item.reason, item.capacity)
        }
        val format = original.format.lowercase()
        val fileName = draftFileName(manifest.attachmentFileName, expectedRevision, format)
        val mediaType = draftMediaType(format)
        val verification = if (format == "hwp") result.verification + mapOf("stage" to "HWPLIB_VERIFIED", "reopened" to true, "outputSha256" to sha256(bytes), "render" to "NOT_RUN") else result.verification
        onStage(ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage.SAVING)
        return listOf(files.save(account.id, id, expectedRevision, fileName, mediaType, bytes, manifest.attachmentSha256, result.placements,
            fingerprint = fingerprint,
            evidence = mapOf("documentMap" to result.documentMap, "writePlan" to result.writePlan, "verification" to verification, "pipelineVersion" to result.pipelineVersion),
            filledAnswerCount = writableFacts.size - skipped.size,
            unfilledAnswers = unfilled, remainingExampleCount = result.remainingExampleCount))
        } catch (error: ApplicationDocumentException) {
            if (error.code == "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN") {
                // 결과를 확인하지 못한 실행은 사람이 확인할 시간만 잠그고, 영구 잠금으로 남기지 않는다.
                outcomeUnknown = true
                redis.expire(lockKey, unknownOutcomeLockTtl)
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
    private fun draftFileName(attachmentFileName: String, revision: Long, format: String) =
        attachmentFileName.replace(Regex("(?i)\\.(hwp|hwpx|pdf|docx|xlsx).*$"), "").replace(Regex("[\\\\/:*?\"<>|]"), "_").take(430) + "_초안_v$revision.$format"
    private fun draftMediaType(format: String) = when (format) { "pdf" -> "application/pdf"; "hwpx" -> "application/hwp+zip";
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; else -> "application/x-hwp" }
    private fun <T> callMcp(block: () -> T): T = try { block() }
    catch (error: ApplicationDocumentMcpException) {
        throw ApplicationDocumentException(error.code, requireNotNull(error.message), error.cause)
    }
}
