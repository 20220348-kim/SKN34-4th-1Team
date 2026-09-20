package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.test.stubDocumentMapping
import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.applicationpreparation.client.ai.AiApplicationPreparationClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormDiscoveryException
import ai.govbiz.core.applicationpreparation.service.backfill.ApplicationFormBackfillInput
import ai.govbiz.core.applicationpreparation.service.backfill.ApplicationFormBackfillService
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.document.*
import ai.govbiz.core.supportprogram.domain.*
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.PlatformTransactionManager
import tools.jackson.databind.ObjectMapper

@SpringBootTest(properties = ["app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.application-form-analysis.enabled=false"])
@Import(MySqlTestContainerConfig::class)
class ApplicationFormAvailabilityIntegrationTest {
    @Autowired lateinit var availability: ApplicationFormAvailabilityRepository
    @Autowired lateinit var worker: ApplicationFormAnalysisService
    @Autowired lateinit var discovery: ApplicationFormDiscoveryService
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean lateinit var snapshots: ApplicationFormSnapshotRepository
    @Autowired lateinit var publication: ai.govbiz.core.supportprogram.service.sync.SupportProgramCatalogPublicationService
    @Autowired lateinit var catalog: SupportProgramRepository
    @Autowired lateinit var importer: ApplicationFormBackfillService
    @Autowired lateinit var json: ObjectMapper
    @Autowired lateinit var jdbc: JdbcTemplate
    @Autowired lateinit var transactions: PlatformTransactionManager
    @MockitoBean lateinit var ai: AiApplicationPreparationClient
    @MockitoBean lateinit var documentMcp: ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
    @org.junit.jupiter.api.BeforeEach
    fun documentMappingStub() { stubDocumentMapping(documentMcp) }

    @MockitoBean lateinit var details: SupportProgramDetailService
    @MockitoBean lateinit var attachments: BizInfoAttachmentClient
    @MockitoBean lateinit var parser: SupportProgramDocumentParser
    private val id = "PBLN_123456"
    private val prompt = "sha256:" + "a".repeat(64)
    private val program = SupportProgram(id, "BIZINFO", "한글 & 지원사업", "기관", "요약", emptyList(), emptyList(),
        "중소기업", "상시", null, null, SupportProgramStatus.OPEN, "기업마당", "https://www.bizinfo.go.kr/notice", emptyList())
    private val bytes = "공식 양식 & 한글".toByteArray()
    private val url = "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=1"
    private fun payload(two: Boolean = false) = AiApplicationFormDiscoveryPayload("application-form-discovery-v1", "test-model", prompt,
        (if (two) listOf(0,1) else listOf(0)).map { index -> AiDiscoveredApplicationFormPayload(index,
            listOf(AiDiscoveredApplicationFormSectionPayload("company", "기업 정보", "신청 기업 정보를 작성합니다.",
                listOf(AiDiscoveredApplicationFormFieldPayload("name", "업체명", "업체명을 입력합니다.", true, "D$index-B0", "업체명"))))) })
    private fun hash(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    private fun state() = requireNotNull(availability.find("BIZINFO", id))
    private fun due() { jdbc.update("UPDATE application_form_availability SET next_retry_at=NOW()-INTERVAL 1 DAY") }
    private fun configureFiles(two: Boolean = false, content: ByteArray = bytes) {
        `when`(attachments.collect("BIZINFO", id)).thenReturn(SupportProgramAttachments(program.title,
            listOf(SupportProgramAttachment(url, "신청서.hwpx", "HWPX", content)) +
                if (two) listOf(SupportProgramAttachment(url+"2", "계획서.hwpx", "HWPX", "second".toByteArray())) else emptyList(), emptyList()))
    }
    @BeforeEach fun setup() {
        jdbc.update("DELETE FROM application_form_availability")
        jdbc.update("DELETE FROM application_form_snapshot")
        `when`(details.get("BIZINFO", id)).thenReturn(program)
        configureFiles()
        `when`(parser.parse(any(ByteArray::class.java) ?: bytes, anyString())).thenReturn(listOf(SupportProgramDocumentBlock("문단 1", "업체명")))
        `when`(ai.discoveryConfiguration()).thenReturn(AiApplicationPreparationConfigurationPayload("application-form-discovery-v1", "test-model", prompt, 210.0, 240.0))
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload())
    }
    @Test fun publishesPendingOnlyWithCommittedCatalog() {
        val generation = catalog.startSyncGeneration("BIZINFO")
        val transaction = TransactionTemplate(transactions)
        assertThrows(IllegalStateException::class.java) {
            transaction.executeWithoutResult { publication.publish("BIZINFO", listOf(CatalogSupportProgram(program, "")), generation); error("sync failed") }
        }
        assertNull(availability.find("BIZINFO", id))
        publication.publish("BIZINFO", listOf(CatalogSupportProgram(program, "")), generation)
        assertEquals(ApplicationFormAvailabilityStatus.PENDING, state().status)
        assertNotNull(state().nextRetryAt)
        verify(ai, never()).discoveryConfiguration()
    }

    @Test fun requestedReanalysisPublishesAnActiveSnapshotWithoutRemovingOldVersions() {
        availability.register("BIZINFO", id, "a".repeat(64))
        val first = discovery.discoverQueued("BIZINFO", id) {}
        val oldVersion = first.forms.first().formVersionId
        assertEquals(oldVersion, availability.requireActive("BIZINFO", id, oldVersion).formVersionId)
        val revisedPrompt = "sha256:" + "b".repeat(64)
        `when`(ai.discoveryConfiguration()).thenReturn(AiApplicationPreparationConfigurationPayload("application-form-discovery-v1", "test-model", revisedPrompt, 210.0, 240.0))
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload().copy(promptVersion=revisedPrompt))
        val second = discovery.discoverQueued("BIZINFO", id) {}
        val newVersion = second.forms.first().formVersionId
        assertNotEquals(oldVersion, newVersion)
        assertEquals(newVersion, availability.requireActive("BIZINFO", id, newVersion).formVersionId)
        assertNotNull(snapshots.findByVersion(oldVersion))
    }

    @Test fun requestedReanalysisDoesNotStealAnActiveWorkerLease() {
        availability.register("BIZINFO", id, "a".repeat(64))
        assertNotNull(availability.claim())
        assertThrows(ApplicationFormDiscoveryException::class.java) { discovery.discoverQueued("BIZINFO", id) {} }
        verify(ai, never()).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
    }

    @Test fun cachedFormsWithLargeDocumentMapsRemainReadableAtDefaultSortBuffer() {
        configureFiles(two=true)
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload(true))
        availability.register("BIZINFO", id, "a".repeat(64))
        val first = discovery.discoverQueued("BIZINFO", id) {}
        val largeMap = mapOf("targets" to (0 until 300).map { index ->
            mapOf("targetId" to "cell-$index", "currentText" to "가상 표 문맥 & 한글\n".repeat(250))
        })
        first.forms.forEach { form ->
            snapshots.attachDocumentMap(form.formVersionId, ApplicationDocumentMapSnapshot(
                "application-document-mcp-v1", "large-map-test", form.attachmentSha256,
                "test-map", "test-engine", emptyList(), emptyList(), largeMap))
        }
        val row = jdbc.queryForMap("SELECT source_fingerprint, parser_version, extraction_model, extraction_prompt_version FROM application_form_snapshot WHERE form_version_id=?", first.forms.first().formVersionId)
        TransactionTemplate(transactions).executeWithoutResult {
            val oldBuffer = jdbc.queryForObject("SELECT @@SESSION.sort_buffer_size", Long::class.java)!!
            try {
                jdbc.execute("SET SESSION sort_buffer_size = 262144")
                val actual = snapshots.findByProgram("BIZINFO", id, row["source_fingerprint"] as String,
                    row["parser_version"] as String, row["extraction_model"] as String, row["extraction_prompt_version"] as String)
                assertEquals(first.forms.map { it.formVersionId }.sorted(), actual.map { it.formVersionId })
                assertTrue(actual.all { it.documentMapSnapshot?.documentMap == largeMap })
            } finally {
                jdbc.execute("SET SESSION sort_buffer_size = $oldBuffer")
            }
        }
    }
    @Test fun multipleSnapshotsBecomeAvailableAndUnchangedInputsDoNotCallAiAgain() {
        configureFiles(two=true)
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload(true))
        availability.register("BIZINFO", id, "a".repeat(64))
        assertTrue(worker.runNext())
        assertEquals(ApplicationFormAvailabilityStatus.AVAILABLE, state().status)
        assertEquals(2, availability.activeForms("BIZINFO", id).size)
        assertNotNull(state().durationMs)
        due(); worker.runNext()
        verify(ai, times(1)).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
    }
    @Test fun noFormIsCachedIncludingCatalogOnlyChange() {
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload().copy(forms=emptyList()))
        availability.register("BIZINFO", id, "a".repeat(64)); worker.runNext()
        assertEquals(ApplicationFormAvailabilityStatus.NO_FORM, state().status)
        availability.register("BIZINFO", id, "b".repeat(64))
        assertEquals(ApplicationFormAvailabilityStatus.STALE, state().status)
        worker.runNext()
        assertEquals(ApplicationFormAvailabilityStatus.NO_FORM, state().status)
        verify(ai, times(1)).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
    }
    @Test fun sourceRecoveryReusesPriorNoFormWithoutCallingAiAgain() {
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenReturn(payload().copy(forms=emptyList()))
        availability.register("BIZINFO", id, "a".repeat(64)); worker.runNext()
        `when`(attachments.collect("BIZINFO", id)).thenThrow(SupportProgramDocumentException(SupportProgramDocumentException.Reason.NOT_FOUND))
        due(); worker.runNext()
        assertEquals(ApplicationFormAvailabilityStatus.DOCUMENT_UNAVAILABLE, state().status)
        doReturn(SupportProgramAttachments(program.title, listOf(SupportProgramAttachment(url, "신청서.hwpx", "HWPX", bytes)), emptyList()))
            .`when`(attachments).collect("BIZINFO", id)
        due(); worker.runNext()
        assertEquals(ApplicationFormAvailabilityStatus.NO_FORM, state().status)
        assertEquals("NO_FORM", state().reasonCode)
        verify(ai, times(1)).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
    }

    @Test fun timeoutRetriesAreBoundedAndRecordStage() {
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))).thenThrow(ApplicationFormTimeoutException("AI_MODEL"))
        availability.register("BIZINFO", id, "a".repeat(64))
        repeat(3) { worker.runNext(); if (it < 2) { assertEquals(ApplicationFormAvailabilityStatus.RETRY_WAITING, state().status); assertNotNull(state().nextRetryAt); due() } }
        assertEquals(ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, state().status)
        assertEquals(3, state().attemptCount)
        assertEquals("AI_MODEL", state().timeoutStage)
        assertNotNull(state().nextRetryAt)
        due(); worker.runNext()
        assertEquals(ApplicationFormAvailabilityStatus.REVIEW_REQUIRED, state().status)
        verify(ai, times(3)).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
    }
    @Test fun changedAttachmentCreatesANewVersionAndOldDraftVersionRemainsReadable() {
        availability.register("BIZINFO", id, "a".repeat(64)); worker.runNext()
        val previous = requireNotNull(state().activeFormVersionId)
        configureFiles(content="changed".toByteArray()); due(); worker.runNext()
        assertNotEquals(previous, state().activeFormVersionId)
        assertNotNull(snapshots.findByVersion(previous))
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
    }
    @Test fun activationFailureRollsBackSnapshots() {
        availability.register("BIZINFO", id, "a".repeat(64))
        doAnswer { invocation ->
            invocation.callRealMethod() // 실제 MyBatis INSERT 후 실패를 주입하여 전체 transaction rollback을 확인한다.
            throw IllegalStateException("snapshot persistence failure")
        }.`when`(snapshots).save(anyList(), anyString(), anyString(),
            any(ApplicationFormDiscoveryConfiguration::class.java) ?: ApplicationFormDiscoveryConfiguration("application-form-discovery-v1", "test-model", prompt))
        assertThrows(IllegalStateException::class.java) { worker.runNext() }
        assertNotEquals(ApplicationFormAvailabilityStatus.AVAILABLE, state().status)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
    }
    @Test fun backfillValidatesEvidenceWithoutAiAndIsIdempotent() {
        catalog.upsert(CatalogSupportProgram(program, ""))
        val analysis: tools.jackson.databind.JsonNode = json.valueToTree(payload())
        val raw = json.readTree("""{"schemaVersion":"application-form-openai-analysis-v2","programs":[{"sourceCode":"BIZINFO","sourceProgramId":"$id",
          "files":[{"sourceUrl":"$url","fileName":"신청서.hwpx","sha256":"${hash(bytes)}"}],
          "aiAnalysis":{"sourceCode":"BIZINFO","sourceProgramId":"$id","status":"FORM_FOUND","contractVersion":"application-form-discovery-v1","model":"test-model","promptVersion":"$prompt","forms":${analysis.path("forms")}}}]}""")
        val path = Files.createTempFile("form-backfill-test", ".json")
        try {
            Files.write(path, json.writeValueAsBytes(raw))
            val input = ApplicationFormBackfillInput(json).read(path, hash(Files.readAllBytes(path)), 1, 1)
            val first = importer.applyValidated(input)
            assertEquals(1, first.availablePrograms); assertEquals(1, first.snapshotCount)
            val second = importer.applyValidated(input)
            assertEquals(1, second.skipped); assertEquals(1, second.snapshotCount)
            publication.publish("BIZINFO", listOf(CatalogSupportProgram(program, "")), catalog.startSyncGeneration("BIZINFO"))
            assertEquals(ApplicationFormAvailabilityStatus.AVAILABLE, state().status)
            verify(ai, never()).discoveryConfiguration()
            verify(ai, never()).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: AiApplicationFormDiscoveryRequest("application-form-discovery-v1", "BIZINFO", id, program.title, emptyList()))
        } finally { Files.deleteIfExists(path) }
    }
}
