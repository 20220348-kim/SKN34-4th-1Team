package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.supportprogram.client.ops.ProductionQualityClient
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityContextRequest
import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationDocumentMcpException
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.*
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationPreparationDetailResult
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import java.security.MessageDigest
import java.time.Duration
import java.time.LocalDateTime
import java.util.Base64
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.ValueOperations
import tools.jackson.module.kotlin.jacksonObjectMapper

/** 실제 Job → Document → Mapping 흐름과 AI Client·저장소 대역으로 호출 기록·상태를 확인한다. 유료 API는 호출하지 않는다. */
class ApplicationDocumentGenerationJobServiceTest {
    private val owner = AccountTestHelper.account()
    private val now = LocalDateTime.of(2026, 10, 6, 12, 0)
    private val source = "official form fixture".toByteArray()
    private val output = "generated document fixture".toByteArray()
    private val pipeline = "b".repeat(64)
    private val binding = ApplicationDocumentPlacement("company:name", "name-cell")
    private val form = ApplicationFormManifest(1, "atomic-form-v1", "BIZINFO", "PBLN_1", "공고", "신청 양식",
        "https://www.bizinfo.go.kr/form", "form.hwpx", source.size.toLong(), hash(source), "SOURCE_DOCUMENT_EXTRACTED", false,
        listOf(ApplicationServiceField.GENERAL), listOf(ApplicationFormSectionDefinition("company", "기업", "table 1", "기업 입력",
            listOf(ApplicationFormFieldDefinition("name", "기업명", "기업명 입력", true)))))
    private val detail = ApplicationPreparationDetailResult(
        StoredApplicationPreparation(9, owner.id, 2, ApplicationProgressStage.PREPARING, 1, now,
            NewApplicationPreparation(form.sourceCode, form.sourceProgramId, form.formVersionId, ApplicationServiceField.GENERAL), now, now),
        form, listOf(ConfirmedApplicationFact(1, "company", "name", ApplicationFactStatus.PROVIDED, "가상 기업", "기업명", 2, now)))
    private val job = ApplicationDocumentGenerationJob(7, owner.id, 9, "11111111-1111-4111-8111-111111111111", 2,
        ApplicationDocumentGenerationJobStatus.RUNNING, ApplicationDocumentGenerationStage.PREPARING, emptyList(), null, null, now, null)
    private val file = ApplicationDocumentFile(11, 2, "form_초안_v2.hwpx", "application/hwp+zip", output)
    private val jobs = mock(ApplicationDocumentGenerationJobRepository::class.java)
    private val accounts = mock(AccountRepository::class.java)
    private val preparations = mock(ApplicationPreparationService::class.java)
    private val client = mock(ApplicationDocumentMcpClient::class.java)
    private val snapshots = mock(ApplicationFormSnapshotRepository::class.java)
    private val editor = mock(ApplicationDocumentEditor::class.java)
    private val attachments = mock(BizInfoAttachmentClient::class.java)
    private val redis = mock(StringRedisTemplate::class.java)
    @Suppress("UNCHECKED_CAST")
    private val values = mock(ValueOperations::class.java) as ValueOperations<String, String>
    private var saveFails = false
    private val files = mock(ApplicationDocumentRepository::class.java, withSettings().defaultAnswer { invocation ->
        if (invocation.method.name == "save") {
            if (saveFails) throw IllegalStateException("file save failed")
            file
        } else RETURNS_DEFAULTS.answer(invocation)
    })
    private val quality = mock(ProductionQualityClient::class.java)
    private val admission = SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties())
    private val documents = ApplicationDocumentService(preparations, redis, files, editor,
        ApplicationDocumentMappingService(client, editor, snapshots), mock(ApplicationDocumentMigrationProposalStore::class.java),
        mock(ApplicationDocumentMigrationRepository::class.java), client, attachments, mock(MsitAttachmentClient::class.java),
        mock(KStartupAttachmentClient::class.java), mock(CnTradeNoticeAttachmentClient::class.java),
        mock(SupportProgramDetailService::class.java), admission, PlanUsageTestHelper.allowAll(),
        mock(ApplicationFormAvailabilityRepository::class.java),
        jacksonObjectMapper(), Duration.ofHours(24), quality)
    private val service = ApplicationDocumentGenerationJobService(jobs, documents, preparations, accounts, admission,
        PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions())
    private val mapRequest = AiDocumentMappingRequest(sourceBase64 = "", sourceSha256 = "", format = "hwpx", scope = "", fields = emptyList())
    private val generationRequest = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "hwpx", answerRevision = 2, facts = emptyList(), scope = "")

    @BeforeEach
    fun prepare() {
        `when`(jobs.claim(job.id)).thenReturn(job)
        `when`(jobs.beginAi(job.id)).thenReturn(true)
        `when`(accounts.findById(owner.id)).thenReturn(owner)
        `when`(preparations.findOwned(owner, job.preparationId)).thenReturn(detail)
        `when`(client.configuration()).thenReturn(AiDocumentConfigurationPayload("application-document-mcp-v1", pipeline))
        `when`(redis.opsForValue()).thenReturn(values)
        `when`(values.setIfAbsent(anyString(), anyString(), any(Duration::class.java) ?: Duration.ofMinutes(15))).thenReturn(true)
        `when`(attachments.collect(form.sourceCode, form.sourceProgramId)).thenReturn(SupportProgramAttachments(form.programTitle,
            listOf(SupportProgramAttachment(form.sourceUrl, form.attachmentFileName, "HWPX", source)), emptyList()))
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)).thenReturn(
            AiDocumentMappingPayload("application-document-mcp-v1", pipeline, hash(source), "test-map", "test-engine",
                listOf(binding), listOf(binding.targetId), mapOf("targets" to listOf(mapOf("targetId" to binding.targetId)))))
        `when`(client.generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)).thenReturn(
            AiDocumentGenerationPayload("application-document-mcp-v1", pipeline, hash(source), 2,
                Base64.getEncoder().encodeToString(output), hash(output), "c".repeat(64), "test-map", "test-engine", emptyMap(),
                listOf(binding), emptyMap(), emptyMap()))
    }

    @Test
    fun disabledWorkerRejectsSubmissionBeforeReservingAJobOrCallingTheDocumentPipeline() {
        val disabled = ApplicationDocumentGenerationJobService(jobs, documents, preparations, accounts, admission,
            PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), jobsEnabled = false)
        val error = assertThrows(ApplicationDocumentException::class.java) {
            disabled.submit(owner, job.preparationId, job.requestKey, job.expectedRevision)
        }
        assertEquals("APPLICATION_DOCUMENT_GENERATION_UNAVAILABLE", error.code)
        verify(jobs).findOwnedRequest(owner.id, job.requestKey)
        verify(jobs, never()).reserve(anyLong(), anyString(), anyLong(), anyLong())
        verifyNoInteractions(preparations, client, redis, attachments)
    }

    @Test
    fun disabledWorkerReturnsAnAlreadyAcceptedRequestWithoutCreatingAnotherJob() {
        val disabled = ApplicationDocumentGenerationJobService(jobs, documents, preparations, accounts, admission,
            PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), jobsEnabled = false)
        `when`(jobs.findOwnedRequest(owner.id, job.requestKey)).thenReturn(job)
        assertEquals(job, disabled.submit(owner, job.preparationId, job.requestKey, job.expectedRevision))
        verify(jobs, never()).reserve(anyLong(), anyString(), anyLong(), anyLong())
        verifyNoInteractions(preparations, client, redis, attachments)
    }

    @Test
    fun disabledWorkerRejectsReusingAnAcceptedKeyForAnotherInputVersion() {
        val disabled = ApplicationDocumentGenerationJobService(jobs, documents, preparations, accounts, admission,
            PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), jobsEnabled = false)
        `when`(jobs.findOwnedRequest(owner.id, job.requestKey)).thenReturn(job)
        assertThrows(ApplicationPreparationRunConflictException::class.java) {
            disabled.submit(owner, job.preparationId, job.requestKey, job.expectedRevision + 1)
        }
        verify(jobs, never()).reserve(anyLong(), anyString(), anyLong(), anyLong())
        verifyNoInteractions(preparations, client, redis, attachments)
    }

    @Test
    fun disabledWorkerStillAllowsTheOwnerToReadAnExistingJob() {
        val disabled = ApplicationDocumentGenerationJobService(jobs, documents, preparations, accounts, admission,
            PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), jobsEnabled = false)
        `when`(jobs.findOwned(owner.id, job.preparationId, job.id)).thenReturn(job)
        assertEquals(job, disabled.get(owner, job.preparationId, job.id))
        verify(jobs).findOwned(owner.id, job.preparationId, job.id)
        verify(jobs, never()).reserve(anyLong(), anyString(), anyLong(), anyLong())
        verifyNoInteractions(client, redis, attachments)
    }

    @Test
    fun firstMappingAndWritingShareOnePersistedAiStart() {
        assertTrue(service.execute(job.id))
        val order = inOrder(jobs, client)
        order.verify(jobs).beginAi(job.id)
        order.verify(client).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        order.verify(client).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verify(jobs, times(1)).beginAi(job.id)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun cachedMappingRecordsAiStartOnlyBeforeWriting() {
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form.copy(documentMapSnapshot =
            ApplicationDocumentMapSnapshot("application-document-mcp-v1", pipeline, hash(source), "test-map", "test-engine",
                listOf(binding), listOf(binding.targetId), mapOf("targets" to listOf(mapOf("targetId" to binding.targetId))))))
        assertTrue(service.execute(job.id))
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        val order = inOrder(jobs, client)
        order.verify(jobs).beginAi(job.id)
        order.verify(client).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verify(jobs, times(1)).beginAi(job.id)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun unexpectedFirstMappingFailureIsRecordedAsUnknownAfterAiStart() {
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)).thenThrow(IllegalStateException("mapping interrupted"))
        assertTrue(service.execute(job.id))
        verify(jobs).beginAi(job.id)
        verifyNoInteractions(quality)
        verify(jobs).fail(job.id, "RUN_OUTCOME_UNKNOWN", "문서 생성 결과를 확인하지 못했습니다. 저장된 문서 목록을 확인한 뒤 필요하면 다시 만들어 주세요.", null, true)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
    }

    @Test
    fun firstMappingTimeoutPreservesTheUnknownOutcomeAndRedisLock() {
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)).thenThrow(
            ApplicationDocumentMcpException("APPLICATION_DOCUMENT_OUTCOME_UNKNOWN", "safe detail", java.net.SocketTimeoutException("internal")))
        assertTrue(service.execute(job.id))
        verify(jobs).beginAi(job.id)
        verify(jobs).fail(job.id, "APPLICATION_DOCUMENT_OUTCOME_UNKNOWN", "safe detail", null, true)
        verify(redis).expire("application-document-run:9", Duration.ofHours(24))
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
    }

    @Test
    fun explicitMappingRejectionKeepsThePaidAttemptRecordButRemainsFailed() {
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)).thenThrow(
            ApplicationDocumentMcpException("APPLICATION_DOCUMENT_MAPPING_FAILED", "safe detail"))
        assertTrue(service.execute(job.id))
        verify(jobs).beginAi(job.id)
        verifyNoInteractions(quality)
        verify(jobs).fail(job.id, "APPLICATION_DOCUMENT_MAPPING_FAILED", "safe detail", null, false)
    }

    @Test
    fun unreachableDocumentServiceFailsBeforeAiStartWithoutHoldingTheSlotOrLock() {
        `when`(client.configuration()).thenThrow(ApplicationDocumentMcpException("APPLICATION_DOCUMENT_MCP_UNAVAILABLE", "safe detail",
            java.net.ConnectException("Connection refused")))
        assertTrue(service.execute(job.id))
        verify(jobs, never()).beginAi(job.id)
        verify(jobs).fail(job.id, "APPLICATION_DOCUMENT_MCP_UNAVAILABLE", "safe detail", null, false)
        verify(redis, never()).expire("application-document-run:9", Duration.ofHours(24))
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
    }

    @Test
    fun lostJobLeasePreventsBothMappingAndWritingCalls() {
        `when`(jobs.beginAi(job.id)).thenReturn(false)
        assertTrue(service.execute(job.id))
        verify(jobs).fail(job.id, "GENERATION_FAILED", "문서를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.", null, false)
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
    }

    @Test
    fun originalDraftWithoutAnswersDoesNotRecordAPaidAttempt() {
        `when`(preparations.findOwned(owner, job.preparationId)).thenReturn(detail.copy(facts = emptyList()))
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).beginAi(anyLong())
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun originalDraftWithOnlyUnknownFactsDoesNotCallMappingOrWriting() {
        `when`(preparations.findOwned(owner, job.preparationId)).thenReturn(detail.copy(
            facts = detail.facts.map { it.copy(status = ApplicationFactStatus.UNKNOWN, value = null) }))
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).beginAi(anyLong())
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun missingRequiredAnswerDoesNotPreventWritingTheProvidedAnswer() {
        val expanded = form.copy(sections = form.sections.map { section -> section.copy(fields = section.fields +
            ApplicationFormFieldDefinition("goal", "추진 목표", "추진 목표 입력", true)) })
        val bindings = listOf(binding, ApplicationDocumentPlacement("company:goal", "goal-cell"))
        `when`(preparations.findOwned(owner, job.preparationId)).thenReturn(detail.copy(form = expanded))
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(expanded.copy(documentMapSnapshot =
            ApplicationDocumentMapSnapshot("application-document-mcp-v1", pipeline, hash(source), "test-map", "test-engine",
                bindings, bindings.map { it.targetId }, mapOf("targets" to bindings.map { mapOf("targetId" to it.targetId) }))))
        assertTrue(service.execute(job.id))
        val request = org.mockito.ArgumentCaptor.forClass(AiDocumentGenerationRequest::class.java)
        verify(client).generate(request.capture() ?: generationRequest)
        assertEquals(listOf("company:name"), request.value.facts.map { it.id })
        assertEquals(listOf(binding), request.value.bindings)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun existingGeneratedFileDoesNotRecordAnotherPaidAttempt() {
        `when`(files.findFingerprint(eq(owner.id), eq(job.preparationId), eq(job.expectedRevision), anyString())).thenReturn(file)
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).beginAi(anyLong())
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verifyNoInteractions(attachments, redis, quality)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    @Test
    fun configurationFailureBeforeAnyPaidRequestDoesNotRecordAiStart() {
        `when`(client.configuration()).thenThrow(IllegalStateException("configuration unavailable"))
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).beginAi(anyLong())
        verify(jobs).fail(job.id, "GENERATION_FAILED", "문서를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.", null, false)
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
    }

    private fun publicAnswers(includeUnmapped: Boolean = false): AiDocumentGenerationPayload {
        val goal = ApplicationFormFieldDefinition("goal", "사업 목표", "확인된 목표를 입력합니다", true)
        val fields = listOf(goal) + if (includeUnmapped) listOf(ApplicationFormFieldDefinition("schedule", "수행 일정", "확인된 일정을 입력합니다", false)) else emptyList()
        val publicForm = form.copy(sections = listOf(form.sections.single().copy(fields = fields)))
        val facts = fields.mapIndexed { index, field -> ConfirmedApplicationFact(index + 1L, "company", field.key,
            ApplicationFactStatus.PROVIDED, if (index == 0) "시험 생산 안정화" else "다음 분기", "원본 확인 문구는 수집하지 않음", 2, now) }
        `when`(preparations.findOwned(owner, job.preparationId)).thenReturn(detail.copy(form = publicForm, facts = facts))
        val publicBinding = ApplicationDocumentPlacement("company:goal", "goal-cell")
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: mapRequest)).thenReturn(
            AiDocumentMappingPayload("application-document-mcp-v1", pipeline, hash(source), "test-map", "test-engine",
                listOf(publicBinding), listOf(publicBinding.targetId), mapOf("targets" to listOf(mapOf("targetId" to publicBinding.targetId)),
                    "unmappedFieldIds" to if (includeUnmapped) listOf("company:schedule") else emptyList<String>())))
        val payload = AiDocumentGenerationPayload("application-document-mcp-v1", pipeline, hash(source), 2,
            Base64.getEncoder().encodeToString(output), hash(output), "c".repeat(64), "test-map", "test-engine",
            mapOf("reopened" to true, "xml" to "PASSED", "render" to "NOT_RUN", "privateText" to "exclude-private-verification", "stage" to "exclude-arbitrary-stage"),
            emptyList(), mapOf("privateDocument" to "exclude-full-map"), mapOf("privatePlan" to "exclude-full-plan",
                "operations" to listOf(mapOf("valueRef" to publicBinding.factId, "targetId" to publicBinding.targetId, "expectedText" to "exclude-raw-source-text"))),
            remainingExampleCount = 2)
        `when`(client.generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)).thenReturn(payload)
        return payload
    }

    @Test
    fun samplesActualDocumentJobOnlyAfterFileSaveWithSafeAnswersAndVerificationAllowlist() {
        publicAnswers(includeUnmapped = true)
        assertTrue(service.execute(job.id))
        verify(jobs).succeed(job.id, listOf(file.id))
        val invocation = mockingDetails(quality).invocations.single { it.method.name == "recordOperation" }
        assertEquals("application-document-generation", invocation.getArgument<String>(0))
        val contexts = invocation.getArgument<List<ProductionQualityContextRequest>>(2)
        assertEquals(listOf("field-1", "field-2"), contexts.map { it.id })
        assertTrue(contexts[0].text.contains("시험 생산 안정화"))
        val summary = invocation.getArgument<String>(3)
        assertTrue(summary.contains("기입 1건 / 미기입 1건 / 남은 예시 2칸"))
        assertTrue(summary.contains("INPUT_LOCATION_NOT_FOUND"))
        assertTrue(summary.contains("goal-cell"))
        assertTrue(summary.contains("검증 reopened: true"))
        assertTrue(summary.contains("검증 render: NOT_RUN"))
        assertTrue(summary.contains("시각적 품질을 검증한 결과가 아닙니다"))
        assertTrue(summary.contains("파일에서 다시 추출한 본문이 아닙니다"))
        val serialized = contexts.joinToString() + summary
        listOf("exclude-private-verification", "exclude-arbitrary-stage", "exclude-full-map", "exclude-full-plan", "exclude-raw-source-text",
            Base64.getEncoder().encodeToString(output), owner.email, form.sourceUrl, form.attachmentFileName,
            "원본 확인 문구는 수집하지 않음").forEach { assertFalse(serialized.contains(it), it) }
        assertEquals("BIZINFO:PBLN_1", invocation.getArgument<String>(6))
        assertTrue(mockingDetails(files).invocations.first { it.method.name == "save" }.sequenceNumber < invocation.sequenceNumber)
    }

    @Test
    fun skipsDocumentSampleContainingIdentityFieldsWithoutBlockingGeneration() {
        assertTrue(service.execute(job.id))
        verify(jobs).succeed(job.id, listOf(file.id))
        verifyNoInteractions(quality)
    }

    @Test
    fun failedFileSaveDoesNotEmitDocumentSample() {
        publicAnswers()
        saveFails = true
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).succeed(anyLong(), anyList())
    }

    @Test
    fun invalidGenerationResultDoesNotEmitDocumentSample() {
        val payload = publicAnswers()
        `when`(client.generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)).thenReturn(payload.copy(outputSha256 = "0".repeat(64)))
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality)
        verify(jobs, never()).succeed(anyLong(), anyList())
    }

    @Test
    fun sampleFailureDoesNotFailSuccessfullySavedDocumentJob() {
        publicAnswers()
        doThrow(IllegalStateException("collector unavailable")).`when`(quality).recordOperation(
            anyString(), anyString(), anyList(), anyString(), anyString(), isNull(), anyString())
        assertTrue(service.execute(job.id))
        verify(jobs).succeed(job.id, listOf(file.id))
        assertFalse(mockingDetails(jobs).invocations.any { it.method.name == "fail" })
    }

    @Test
    fun documentReadDownloadAndArchiveDoNotEmitAnotherSample() {
        publicAnswers()
        service.execute(job.id)
        `when`(files.listOwned(owner.id, job.preparationId)).thenReturn(listOf(file))
        `when`(files.findOwned(owner.id, job.preparationId, file.id)).thenReturn(file)
        documents.current(owner, job.preparationId)
        documents.download(owner, job.preparationId, file.id)
        documents.archive(owner, job.preparationId, file.inputRevision)
        assertEquals(1, mockingDetails(quality).invocations.count { it.method.name == "recordOperation" })
    }

    @Test
    fun resultSavedBetweenInitialLookupAndLockIsReusedWithoutSampling() {
        `when`(files.findFingerprint(eq(owner.id), eq(job.preparationId), eq(job.expectedRevision), anyString())).thenReturn(null, file)
        assertTrue(service.execute(job.id))
        verifyNoInteractions(quality, attachments)
        verify(client, never()).generate(any(AiDocumentGenerationRequest::class.java) ?: generationRequest)
        verify(jobs).succeed(job.id, listOf(file.id))
    }

    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
