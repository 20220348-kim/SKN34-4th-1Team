package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core._common.test.stubDocumentMapping
import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.applicationpreparation.client.ai.AiApplicationPreparationClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_PREPARATION_CONTRACT_VERSION
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationConfigurationPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationSuggestionPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentBlock
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import java.util.UUID
import org.hamcrest.Matchers.endsWith
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.ObjectMapper
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.`when`
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDraftRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDraftPayload
import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentConfigurationPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentMappingPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentMappingRequest
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor

/** 실제 세션부터 manifest·MyBatis·MySQL까지 신청 준비 기본 흐름을 연결합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.account.cookie-secure=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class, ai.govbiz.core._common.test.RedisTestContainerConfig::class)
class ApplicationPreparationApiIntegrationTest {
    @Autowired private lateinit var snapshotRepository: ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
    @Autowired private lateinit var documentEditor: ApplicationDocumentEditor
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    @MockitoBean private lateinit var ai: AiApplicationPreparationClient
    @MockitoBean private lateinit var documentMcp: ApplicationDocumentMcpClient
    @MockitoBean private lateinit var details: SupportProgramDetailService
    @MockitoBean private lateinit var bizInfoAttachments: BizInfoAttachmentClient
    @MockitoBean private lateinit var msitAttachments: MsitAttachmentClient
    @MockitoBean private lateinit var kStartupAttachments: KStartupAttachmentClient
    @MockitoBean private lateinit var cnTradeNoticeAttachments: CnTradeNoticeAttachmentClient
    @MockitoBean private lateinit var documentParser: SupportProgramDocumentParser
    private lateinit var owner: Cookie
    private lateinit var other: Cookie
    private var ownerId = 0L

    private fun activateStored(version: String) {
        jdbc.update("""INSERT INTO application_form_availability
          (source_code, source_program_id, catalog_fingerprint, source_fingerprint, parser_version, extraction_model,
           extraction_prompt_version, status, reason_code, active_form_version_id)
          SELECT source_code, source_program_id, source_fingerprint, source_fingerprint, parser_version, extraction_model,
           extraction_prompt_version, 'AVAILABLE', 'FORM_FOUND', form_version_id FROM application_form_snapshot WHERE form_version_id=?""", version)
    }

    @BeforeEach
    fun prepareSessions() {
        stubDocumentMapping(documentMcp)
        jdbc.update("DELETE FROM application_preparation")
        jdbc.update("DELETE FROM application_form_availability")
        jdbc.update("DELETE FROM application_form_snapshot")
        val seed = org.springframework.core.io.ClassPathResource("application-preparation/innovation-voucher-2026-v1.json").inputStream.use {
            json.readValue(it, ApplicationFormManifest::class.java)
        }
        snapshotRepository.save(listOf(seed), "a".repeat(64), "test", ApplicationFormDiscoveryConfiguration("application-form-discovery-v1", "test-model", DISCOVERY_PROMPT_VERSION))
        activateStored(seed.formVersionId)
        val first = newSession()
        ownerId = first.first
        owner = first.second
        other = newSession().second
        `when`(ai.configuration()).thenReturn(
            AiApplicationPreparationConfigurationPayload(AI_APPLICATION_PREPARATION_CONTRACT_VERSION, "test-model", PROMPT_VERSION),
        )
        `when`(ai.discoveryConfiguration()).thenReturn(
            AiApplicationPreparationConfigurationPayload(AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION, "test-model", DISCOVERY_PROMPT_VERSION),
        )
        `when`(ai.interpret(any(AiApplicationPreparationInterpretRequest::class.java) ?: fallbackAiRequest())).thenAnswer { invocation ->
            val request = invocation.getArgument<AiApplicationPreparationInterpretRequest>(0)
            AiApplicationPreparationInterpretPayload(
                AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
                "test-model",
                PROMPT_VERSION,
                request.preparationId,
                request.inputRevision,
                request.formVersionId,
                request.sectionKey,
                listOf(AiApplicationPreparationSuggestionPayload("company-name", "PROVIDED", "새봄테크", "업체명은 새봄테크")),
                listOf("contact-person", "company-history", "main-products", "main-customers"),
                "신청 업무 담당자의 이름과 역할은 무엇인가요?",
            )
        }
        val program = SupportProgram(
            DISCOVERY_PROGRAM_ID, "BIZINFO", "동적 지원사업", "지원기관", "공고 요약", emptyList(), emptyList(),
            "중소기업", "2026-01-01 ~ 2026-12-31", null, null, SupportProgramStatus.OPEN,
            "기업마당", "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$DISCOVERY_PROGRAM_ID",
            emptyList(),
        )
        val bytes = "official-form".toByteArray()
        `when`(details.get("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(program)
        `when`(bizInfoAttachments.collect("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(
            SupportProgramAttachments(
                program.title,
                listOf(SupportProgramAttachment("https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=1", "사업계획서.hwpx", "HWPX", bytes)),
                listOf("원문 대조 필요"),
            ),
        )
        val msitProgram = program.copy(
            id = MSIT_PROGRAM_ID,
            sourceCode = "MSIT",
            sourceName = "과학기술정보통신부",
            sourceUrl = MSIT_SOURCE_URL,
        )
        `when`(details.get("MSIT", MSIT_PROGRAM_ID)).thenReturn(msitProgram)
        `when`(msitAttachments.collect("MSIT", MSIT_PROGRAM_ID, MSIT_SOURCE_URL)).thenReturn(
            SupportProgramAttachments(
                msitProgram.title,
                listOf(SupportProgramAttachment(
                    "https://www.msit.go.kr/ssm/file/fileDown.do?atchFileNo=52935&fileOrd=6&fileBtn=A",
                    "신청양식.hwpx",
                    "HWPX",
                    bytes,
                )),
                listOf("과기정통부 원문 대조 필요"),
            ),
        )
        val hwpBytes = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val kStartupProgram = program.copy(
            id = KSTARTUP_PROGRAM_ID,
            sourceCode = "KSTARTUP",
            sourceName = "K-Startup",
            sourceUrl = KSTARTUP_SOURCE_URL,
        )
        `when`(details.get("KSTARTUP", KSTARTUP_PROGRAM_ID)).thenReturn(kStartupProgram)
        `when`(kStartupAttachments.collect("KSTARTUP", KSTARTUP_PROGRAM_ID, KSTARTUP_SOURCE_URL)).thenReturn(
            SupportProgramAttachments(
                kStartupProgram.title,
                listOf(SupportProgramAttachment("https://www.k-startup.go.kr/afile/fileDownload/test", "신청양식.hwp", "HWP", hwpBytes)),
                listOf("K-Startup 원문 대조 필요"),
            ),
        )
        val cnTradeProgram = program.copy(
            id = CNTRADE_PROGRAM_ID,
            sourceCode = "CNTRADE_NOTICE",
            sourceName = "충청남도 온라인수출지원시스템",
            sourceUrl = CNTRADE_SOURCE_URL,
            targetDescription = CNTRADE_BODY,
        )
        val pdfBytes = org.apache.pdfbox.pdmodel.PDDocument().use { pdf ->
            pdf.addPage(org.apache.pdfbox.pdmodel.PDPage())
            java.io.ByteArrayOutputStream().use { output -> pdf.save(output); output.toByteArray() }
        }
        `when`(details.get("CNTRADE_NOTICE", CNTRADE_PROGRAM_ID)).thenReturn(cnTradeProgram)
        `when`(cnTradeNoticeAttachments.collect("CNTRADE_NOTICE", CNTRADE_PROGRAM_ID, cnTradeProgram.title, CNTRADE_BODY)).thenReturn(
            SupportProgramAttachments(
                cnTradeProgram.title,
                listOf(SupportProgramAttachment("https://cntrade.chungnam.go.kr/fileDownload.do?uniqueKey=test", "신청서.pdf", "PDF", pdfBytes)),
                listOf("충남 원문 대조 필요"),
            ),
        )
        `when`(documentParser.parse(bytes, "HWPX")).thenReturn(
            listOf(SupportProgramDocumentBlock(DISCOVERY_LOCATOR, DISCOVERY_BLOCK_TEXT)),
        )
        `when`(documentParser.parse(hwpBytes, "HWP")).thenReturn(
            listOf(SupportProgramDocumentBlock("HWP paragraph 1 part 1", DISCOVERY_BLOCK_TEXT)),
        )
        `when`(documentParser.parse(pdfBytes, "PDF")).thenReturn(
            listOf(SupportProgramDocumentBlock("PDF page 1 part 1", DISCOVERY_BLOCK_TEXT)),
        )
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscoveryRequest())).thenReturn(
            json.readValue(resource("discovery-contract-response.json"), AiApplicationFormDiscoveryPayload::class.java),
        )
    }

    @Test fun readsAvailabilityWithoutDiscoveryAndRejectsStaleNewDrafts() {
        mvc.perform(get("$BASE/forms/availability").cookie(owner).param("sourceCode", "BIZINFO").param("sourceProgramId", "PBLN_000000000118979"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.state.status").value("AVAILABLE"))
            .andExpect(jsonPath("$.forms.items[0].formVersionId").value(FORM_VERSION))
        verify(ai, org.mockito.Mockito.never()).discoveryConfiguration()
        jdbc.update("UPDATE application_form_availability SET status='STALE', active_form_version_id=NULL, reason_code='SOURCE_CHANGED'")
        mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(payload()))
            .andExpect(status().isUnprocessableEntity())
    }

    @Test
    fun listsTheVerifiedFormWithoutCreatingAPreparation() {
        mvc.perform(get("$BASE/forms").cookie(owner))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].sourceProgramId").value("PBLN_000000000118979"))
            .andExpect(jsonPath("$.items[0].verificationStatus").value("SOURCE_HASH_AND_LOCATORS_VERIFIED"))
            .andExpect(jsonPath("$.items[0].institutionReviewed").value(false))
            .andExpect(jsonPath("$.items[0].sections.length()").value(3))
            .andExpect(jsonPath("$.items[0].sections[0].status").value("NOT_STARTED"))
        assertEquals(0, count())
    }

    @Test
    fun discoversAnOfficialFormPersistsTheSnapshotAndCreatesAPreparationFromIt() {
        val response = mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.cached").value(false))
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].verificationStatus").value("SOURCE_DOCUMENT_EXTRACTED"))
            .andExpect(jsonPath("$.items[0].supportedServiceFields[0]").value("GENERAL"))
            .andExpect(jsonPath("$.items[0].sections[0].fields[0].label").value("사업 개요"))
            .andReturn().response
        val formVersionId = json.readTree(response.contentAsString).path("items").path(0).path("formVersionId").asString()
        activateStored(formVersionId)
        mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID","formVersionId":"$formVersionId","serviceField":"GENERAL"}"""))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.form.formVersionId").value(formVersionId))
            .andExpect(jsonPath("$.form.sections[0].fields[0].key").value("business-overview"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot WHERE form_version_id = ?", Int::class.java, formVersionId))

        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}"""))
            .andExpect(status().isOk()).andExpect(jsonPath("$.cached").value(true))
        verify(bizInfoAttachments, times(2)).collect("BIZINFO", DISCOVERY_PROGRAM_ID)
        verify(ai, times(1)).discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscoveryRequest())
    }

    @Test
    fun createsAndReadsAnOwnedPreparationWithoutCallingAi() {
        val response = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(payload()))
            .andExpect(status().isCreated())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.inputRevision").value(1))
            .andExpect(jsonPath("$.progressStage").value("PREPARING"))
            .andExpect(jsonPath("$.progressRevision").value(1))
            .andExpect(jsonPath("$.progressStageUpdatedAt", endsWith("+09:00")))
            .andExpect(jsonPath("$.serviceField").value("TECHNICAL_SUPPORT"))
            .andExpect(jsonPath("$.form.sections.length()").value(3))
            .andExpect(jsonPath("$.ownerAccountId").doesNotExist())
            .andExpect(jsonPath("$.createdAt", endsWith("+09:00")))
            .andReturn().response
        val id = json.readTree(response.contentAsString).path("id").asLong()
        assertEquals("$BASE/$id", response.getHeader(HttpHeaders.LOCATION))
        assertEquals(ownerId, jdbc.queryForObject("SELECT owner_account_id FROM application_preparation WHERE id = ?", Long::class.java, id))
        mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isOk()).andExpect(content().json(response.contentAsString))
        mvc.perform(get("$BASE/$id").cookie(other)).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_NOT_FOUND"))
    }

    @Test
    fun updatesOnlyTheOwnedProgressWithItsIndependentRevision() {
        val id = create(owner)
        val body = """{"expectedProgressRevision":1,"progressStage":"APPLIED"}"""

        mvc.perform(put("$BASE/$id/progress-stage").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.progressStage").value("APPLIED"))
            .andExpect(jsonPath("$.progressRevision").value(2))
            .andExpect(jsonPath("$.inputRevision").value(1))

        mvc.perform(put("$BASE/$id/progress-stage").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_REVISION_CONFLICT"))
        mvc.perform(put("$BASE/$id/progress-stage").cookie(other).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedProgressRevision":2,"progressStage":"SELECTED"}"""))
            .andExpect(status().isNotFound())
        mvc.perform(put("$BASE/$id/progress-stage").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedProgressRevision":2,"progressStage":"UNKNOWN"}"""))
            .andExpect(status().isBadRequest())
    }

    @Test
    fun discoversAnMsitOfficialFormThroughTheSameApplicationUseCase() {
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"MSIT","sourceProgramId":"$MSIT_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].sourceCode").value("MSIT"))
            .andExpect(jsonPath("$.items[0].sourceProgramId").value(MSIT_PROGRAM_ID))
            .andExpect(jsonPath("$.items[0].sourceUrl").value(MSIT_SOURCE_URL))
            .andExpect(jsonPath("$.warnings[0]").value("과기정통부 원문 대조 필요"))
        verify(msitAttachments).collect("MSIT", MSIT_PROGRAM_ID, MSIT_SOURCE_URL)
    }

    @Test
    fun discoversKStartupAndCnTradeFormsThroughTheirProviderClients() {
        mvc.perform(post("$BASE/forms/discover").cookie(other).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"KSTARTUP","sourceProgramId":"$KSTARTUP_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].sourceCode").value("KSTARTUP"))
            .andExpect(jsonPath("$.items[0].attachmentFileName").value("신청양식.hwp"))

        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"CNTRADE_NOTICE","sourceProgramId":"$CNTRADE_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].sourceCode").value("CNTRADE_NOTICE"))
            .andExpect(jsonPath("$.items[0].attachmentFileName").value("신청서.pdf"))

        verify(kStartupAttachments).collect("KSTARTUP", KSTARTUP_PROGRAM_ID, KSTARTUP_SOURCE_URL)
        verify(cnTradeNoticeAttachments).collect("CNTRADE_NOTICE", CNTRADE_PROGRAM_ID, "동적 지원사업", CNTRADE_BODY)
    }

    @Test
    fun deletesOnlyAnOwnedPreparationAndReturnsNoContent() {
        val id = create(owner)
        mvc.perform(delete("$BASE/$id").cookie(other).header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_NOT_FOUND"))

        mvc.perform(delete("$BASE/$id").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
        mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isNotFound())
        mvc.perform(delete("$BASE/$id").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN))
            .andExpect(status().isNotFound())
    }

    @Test
    fun paginatesOnlyOwnedPreparations() {
        val oldest = create(owner)
        create(other)
        val middle = create(owner, "CONSULTING")
        val newest = create(owner, "MARKETING")
        mvc.perform(get(BASE).cookie(owner).param("size", "2"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].id").value(newest))
            .andExpect(jsonPath("$.items[0].progressStage").value("PREPARING"))
            .andExpect(jsonPath("$.items[0].progressRevision").value(1))
            .andExpect(jsonPath("$.items[1].id").value(middle))
            .andExpect(jsonPath("$.nextBeforeId").value(middle))
            .andExpect(jsonPath("$.items[0].form").doesNotExist())
        mvc.perform(get(BASE).cookie(owner).param("size", "2").param("beforeId", middle.toString()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].id").value(oldest))
            .andExpect(jsonPath("$.nextBeforeId").isEmpty())
    }

    @Test
    fun rejectsUnsupportedOrInvalidSelectionsBeforeWriting() {
        for (body in listOf(
            payload().replace("PBLN_000000000118979", "PBLN_999"),
            payload().replace(FORM_VERSION, "other-form-v1"),
        )) {
            mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.code").value("APPLICATION_FORM_NOT_SUPPORTED"))
        }
        for (body in listOf(
            "{}",
            "{",
            payload().replace("BIZINFO", " BIZINFO"),
            payload().replace("TECHNICAL_SUPPORT", "UNKNOWN"),
            payload().replace(FORM_VERSION, "잘못된"),
        )) {
            mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
                .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
        }
        assertEquals(0, count())
    }

    @Test
    fun requiresAnActiveSessionAndAnAllowedOrigin() {
        mvc.perform(get(BASE)).andExpect(status().isUnauthorized())
        mvc.perform(get("$BASE/forms")).andExpect(status().isUnauthorized())
        mvc.perform(post(BASE).cookie(owner).contentType(MediaType.APPLICATION_JSON).content(payload()))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("SESSION_ORIGIN_REJECTED"))
        mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, "https://evil.example")
            .contentType(MediaType.APPLICATION_JSON).content(payload()))
            .andExpect(status().isForbidden())
        assertEquals(0, count())
    }

    @Test
    fun interpretsWithoutSavingAndThenStoresOnlyUserConfirmedFacts() {
        val id = create(owner)
        val requestKey = "0a504895-77bd-4d34-bc61-3e6d12389042"
        val message = "업체명은 새봄테크입니다."
        mvc.perform(post("$BASE/$id/sections/company-overview/messages").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"requestKey":"$requestKey","message":"$message"}"""))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.inputRevision").value(1))
            .andExpect(jsonPath("$.suggestions[0].fieldKey").value("company-name"))
            .andExpect(jsonPath("$.suggestions[0].value").value("새봄테크"))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation_fact", Int::class.java))
        assertEquals("SUCCEEDED", jdbc.queryForObject(
            "SELECT run_status FROM application_preparation_interpretation_run WHERE preparation_id = ?",
            String::class.java,
            id,
        ))
        assertEquals("새봄테크", jdbc.queryForObject(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(output_json, '${'$'}.suggestions[0].value')) FROM application_preparation_interpretation_run WHERE preparation_id = ?",
            String::class.java,
            id,
        ))

        mvc.perform(put("$BASE/$id/sections/company-overview/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"facts":[
                {"fieldKey":"company-name","status":"PROVIDED","value":"새봄테크 & 연구소","sourceText":"$message"},
                {"fieldKey":"contact-person","status":"UNKNOWN","value":null,"sourceText":"담당자는 아직 미정입니다."}
            ]}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.inputRevision").value(2))
            .andExpect(jsonPath("$.form.sections[0].status").value("IN_PROGRESS"))
            .andExpect(jsonPath("$.form.sections[0].facts[0].value").value("새봄테크 & 연구소"))
            .andExpect(jsonPath("$.form.sections[0].facts[1].status").value("UNKNOWN"))

        mvc.perform(put("$BASE/$id/sections/company-overview/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"facts":[]}"""))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_REVISION_CONFLICT"))
        mvc.perform(post("$BASE/$id/sections/company-overview/messages").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"requestKey":"$requestKey","message":"$message"}"""))
            .andExpect(status().isOk()).andExpect(jsonPath("$.inputRevision").value(1))
        verify(ai, times(1)).interpret(any(AiApplicationPreparationInterpretRequest::class.java) ?: fallbackAiRequest())
    }

    @Test
    fun rejectsUnsupportedFieldsSectionsAndOtherOwnersWithoutWriting() {
        val id = create(owner)
        mvc.perform(put("$BASE/$id/sections/company-overview/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"facts":[{"fieldKey":"invented","status":"PROVIDED","value":"값","sourceText":"원문"}]}"""))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("REQUEST_VALIDATION_FAILED"))
        mvc.perform(post("$BASE/$id/sections/not-supported/messages").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"requestKey":"0a504895-77bd-4d34-bc61-3e6d12389042","message":"답변"}"""))
            .andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_SECTION_NOT_FOUND"))
        mvc.perform(put("$BASE/$id/sections/company-overview/inputs").cookie(other).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedRevision":1,"facts":[]}"""))
            .andExpect(status().isNotFound())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation_fact", Int::class.java))
    }

    @Test
    fun createsEditsConfirmsAndReloadsDraftsThroughOwnedHttpContracts() {
        val id = create(owner)
        val endpoint = "$BASE/$id/sections/company-overview"
        val requestKey = UUID.randomUUID().toString()
        fun generate(session: Cookie = owner) = post("$endpoint/drafts").cookie(session).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedRevision":2,"expectedVersionId":null,"requestKey":"$requestKey"}""")
        mvc.perform(post("$endpoint/drafts").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"expectedVersionId":null,"requestKey":"$requestKey"}"""))
            .andExpect(status().isBadRequest())
        val fields = listOf("company-name", "contact-person", "company-history", "main-products", "main-customers")
        val facts = fields.map { field -> mapOf("fieldKey" to field, "status" to "UNKNOWN", "value" to null, "sourceText" to "미정") }
        mvc.perform(put("$endpoint/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(mapOf("expectedRevision" to 1, "facts" to facts))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.form.sections[0].status").value("INPUT_CONFIRMED"))
        `when`(ai.draftConfiguration()).thenReturn(AiApplicationPreparationConfigurationPayload("application-preparation-draft-v1", "test-model", PROMPT_VERSION))
        val fallback = AiApplicationDraftRequest(preparationId = id, inputRevision = 2, formVersionId = FORM_VERSION,
            sectionKey = "company-overview", serviceField = "TECHNICAL_SUPPORT", sectionTitle = "기업 개요", sectionDescription = "설명",
            currentFacts = emptyList(), fieldOptions = emptyList())
        `when`(ai.draft(any(AiApplicationDraftRequest::class.java) ?: fallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiApplicationDraftRequest>(0)
            AiApplicationDraftPayload("application-preparation-draft-v1", id, 2, FORM_VERSION, "company-overview", "test-model", PROMPT_VERSION,
                request.fieldOptions.joinToString("\n") { "${it.label}: 미정" }, emptyList())
        }
        mvc.perform(generate(other)).andExpect(status().isNotFound())
        val generated = mvc.perform(generate()).andExpect(status().isOk())
            .andExpect(jsonPath("$.contents[0].kind").value("AI_DRAFT"))
            .andExpect(jsonPath("$.contents[0].stale").value(false)).andReturn().response
        val first = json.readTree(generated.contentAsString).path("contents").path(0).path("id").asLong()
        mvc.perform(generate()).andExpect(status().isOk()).andExpect(jsonPath("$.contents.length()").value(1))
        verify(ai, times(1)).draft(any(AiApplicationDraftRequest::class.java) ?: fallback)
        val saved = mvc.perform(put("$endpoint/content").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(mapOf("expectedRevision" to 2, "expectedVersionId" to first, "content" to "사용자가 수정한 문안 😀"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.contents.length()").value(2)).andReturn().response
        val second = json.readTree(saved.contentAsString).path("contents").path(0).path("id").asLong()
        mvc.perform(put("$BASE/$id/progress-stage").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedProgressRevision":1,"progressStage":"APPLIED"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.progressStage").value("APPLIED"))
            .andExpect(jsonPath("$.inputRevision").value(2))
            .andExpect(jsonPath("$.contents[0].id").value(second))
            .andExpect(jsonPath("$.contents[0].content").value("사용자가 수정한 문안 😀"))
        mvc.perform(post("$endpoint/confirmations").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":2,"expectedVersionId":$second}"""))
            .andExpect(status().isOk()).andExpect(jsonPath("$.contents[0].confirmedAt").isNotEmpty())
        mvc.perform(get("$BASE/$id").cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$.contents[0].content").value("사용자가 수정한 문안 😀"))
        mvc.perform(put("$endpoint/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":2,"facts":[]}"""))
            .andExpect(status().isOk()).andExpect(jsonPath("$.contents[0].stale").value(true))
        mvc.perform(post("$endpoint/confirmations").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":3,"expectedVersionId":$second}"""))
            .andExpect(status().isConflict())
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = [false, true])
    fun generatesHwpInsideCoreAndRejectsAnEditedSourceFromAi(tamperSource: Boolean) {
        val native = kr.dogfoot.hwplib.tool.blankfilemaker.BlankFileMaker.make()
        native.bodyText.sectionList[0].addNewParagraph().apply {
            createText(); text.addString("____"); createCharShape(); charShape.addParaCharShape(0, 0)
        }
        val original = java.io.ByteArrayOutputStream().also { kr.dogfoot.hwplib.writer.HWPWriter.toStream(native, it) }.toByteArray()
        val target = documentEditor.inspect(original, "hwp").targets.single { it.text == "____" }
        `when`(bizInfoAttachments.collect("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(SupportProgramAttachments("동적 지원사업", listOf(
            SupportProgramAttachment("https://www.bizinfo.go.kr/file", "신청양식.hwp", "HWP", original)), emptyList()))
        `when`(documentParser.parse(original, "HWP")).thenReturn(listOf(SupportProgramDocumentBlock(DISCOVERY_LOCATOR, DISCOVERY_BLOCK_TEXT)))
        stubDocumentMapping(documentMcp, target.id)
        val fallback = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "hwp", answerRevision = 1, facts = emptyList(), scope = "test")
        `when`(documentMcp.generate(any(AiDocumentGenerationRequest::class.java) ?: fallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiDocumentGenerationRequest>(0)
            assertEquals(target.id, request.hwpTargets.single { it.text == "____" }.id)
            assertEquals(emptyList<Any>(), request.pdfTargets)
            val op = sortedMapOf<String, Any?>("targetId" to target.id, "operation" to "replace_range", "expectedText" to "____",
                "start" to 0, "end" to 4, "valueRef" to "business-plan:business-overview", "box" to null, "reason" to "공식 입력란", "stylePolicy" to "preserve")
            val plan = sortedMapOf<String, Any?>("sourceSha256" to request.sourceSha256, "mapVersion" to "native-map-v2",
                "answerRevision" to request.answerRevision, "operations" to listOf(op), "scopeTargetIds" to listOf(target.id), "unresolvedTargets" to emptyList<String>())
            fun hash(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val planHash = hash(json.writeValueAsBytes(plan))
            plan["planHash"] = planHash
            val returned = if (tamperSource) original + byteArrayOf(0) else original
            AiDocumentGenerationPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256, request.answerRevision,
                java.util.Base64.getEncoder().encodeToString(returned), hash(returned), planHash, "native-map-v2", "kr.dogfoot/hwplib@1.1.11",
                mapOf("stage" to "HWPLIB_REQUIRED"), listOf(ApplicationDocumentPlacement("business-plan:business-overview", target.id)), emptyMap(), plan)
        }
        val discovery = mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}""")).andExpect(status().isOk()).andReturn().response
        val version = json.readTree(discovery.contentAsString).path("items").path(0).path("formVersionId").asString()
        activateStored(version)
        val created = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID","formVersionId":"$version","serviceField":"GENERAL"}"""))
            .andExpect(status().isCreated()).andReturn().response
        val id = json.readTree(created.contentAsString).path("id").asLong()
        mvc.perform(put("$BASE/$id/sections/business-plan/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"facts":[{"fieldKey":"business-overview","status":"PROVIDED","value":"가상 & 연구소","sourceText":"가상 & 연구소"}]}"""))
            .andExpect(status().isOk())
        val generation = mvc.perform(post("$BASE/$id/documents").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":2}"""))
        if (tamperSource) {
            generation.andExpect(status().isUnprocessableContent()).andExpect(jsonPath("$.code").value("APPLICATION_DOCUMENT_VALIDATION_FAILED"))
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_file WHERE preparation_id = ?", Int::class.java, id))
        } else {
            val response = generation.andExpect(status().isOk()).andReturn().response
            val fileId = json.readTree(response.contentAsString).path(0).path("id").asLong()
            val downloaded = mvc.perform(get("$BASE/$id/documents/$fileId/download").cookie(owner))
                .andExpect(status().isOk()).andExpect(content().contentType("application/x-hwp")).andReturn().response.contentAsByteArray
            assertEquals("가상 & 연구소", documentEditor.inspect(downloaded, "hwp").targets.single { it.id == target.id }.text)
            mvc.perform(get("$BASE/$id/documents/$fileId/download").cookie(other)).andExpect(status().isNotFound())
            assertEquals("HWPLIB_VERIFIED", jdbc.queryForObject("SELECT JSON_UNQUOTE(JSON_EXTRACT(placements_json, '$.mcp.verification.stage')) FROM application_document_file WHERE id = ?", String::class.java, fileId))
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = [false, true])
    fun generatesDownloadsAndRegeneratesOriginalHwpxWithSessionOwnershipAndStoredFiles(blueExamples: Boolean) {
        val blueForm = java.io.ByteArrayOutputStream().also { out -> java.util.zip.ZipOutputStream(out).use { zip ->
            mapOf(
                "Contents/header.xml" to """<hh:head xmlns:hh="urn:header"><hh:charProperties itemCnt="2"><hh:charPr id="0" textColor="#000000"/><hh:charPr id="1" textColor="#0000FF"/></hh:charProperties></hh:head>""",
                "Contents/section0.xml" to """<hp:sec xmlns:hp="urn:paragraph"><hp:p><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p><hp:p><hp:run charPrIDRef="1"><hp:t>구현 방법을 작성</hp:t></hp:run></hp:p><hp:p><hp:run charPrIDRef="1"><hp:t>사업계획서</hp:t></hp:run></hp:p></hp:sec>""",
            ).forEach { (name, text) -> zip.putNextEntry(java.util.zip.ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry() }
        } }.toByteArray()
        val original = if (blueExamples) blueForm else requireNotNull(javaClass.getResourceAsStream("/combinationreview/general.hwpx")).readBytes()
        val target = documentEditor.inspect(original, "HWPX").targets.first { it.text.isBlank() }
        `when`(bizInfoAttachments.collect("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(SupportProgramAttachments("동적 지원사업", listOf(
            SupportProgramAttachment("https://www.bizinfo.go.kr/file", "신청양식.hwpx", "HWPX", original),
        ), emptyList()))
        `when`(documentParser.parse(original, "HWPX")).thenReturn(listOf(SupportProgramDocumentBlock(DISCOVERY_LOCATOR, DISCOVERY_BLOCK_TEXT)))
        val fallback = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "hwpx", answerRevision = 1, facts = emptyList(), scope = "test")
        val inspected = documentEditor.inspect(original, "HWPX").targets
        val cleanup = if (blueExamples) listOf(inspected.single { it.text == "구현 방법을 작성" }.id) else emptyList()
        val placements = listOf(ApplicationDocumentPlacement("business-plan:business-overview", target.id))
        stubDocumentMapping(documentMcp, target.id)

        var rejectNext = blueExamples
        // HTTP/MCP is a stub here; actual editor sessions are covered by document-tools/smoke.py.
        `when`(documentMcp.generate(any(AiDocumentGenerationRequest::class.java) ?: fallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiDocumentGenerationRequest>(0)
            if (rejectNext) {
                rejectNext = false
                throw ApplicationDocumentException("APPLICATION_DOCUMENT_VALIDATION_FAILED", "검증 실패 fixture")
            }
            org.junit.jupiter.api.Assertions.assertArrayEquals(original, java.util.Base64.getDecoder().decode(request.sourceBase64))
            val bytes = documentEditor.fill(original, "HWPX", request.facts, placements, cleanup)
            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            AiDocumentGenerationPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256, request.answerRevision,
                java.util.Base64.getEncoder().encodeToString(bytes), hash, "c".repeat(64), "native-map-v2", "test-stub",
                mapOf("verified" to 1, "unresolved" to 0), placements, emptyMap(), mapOf("answerRevision" to request.answerRevision))
        }
        val discovered = mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}""")).andExpect(status().isOk()).andReturn().response
        val version = json.readTree(discovered.contentAsString).path("items").path(0).path("formVersionId").asString()
        val mapBeforeQuestions = requireNotNull(snapshotRepository.findByVersion(version)?.documentMapSnapshot)
        assertEquals(listOf("business-plan:business-overview"), mapBeforeQuestions.bindings.map { it.factId })
        assertEquals(target.id, mapBeforeQuestions.bindings.single().targetId)
        org.junit.jupiter.api.Assertions.assertFalse(json.readTree(discovered.contentAsString).path("items").path(0).has("documentMapSnapshot"))

        activateStored(version)
        val created = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID","formVersionId":"$version","serviceField":"GENERAL"}""")).andExpect(status().isCreated()).andReturn().response
        val id = json.readTree(created.contentAsString).path("id").asLong()
        fun save(revision: Long, value: String) {
            mvc.perform(put("$BASE/$id/sections/business-plan/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
                .content("""{"expectedRevision":$revision,"facts":[{"fieldKey":"business-overview","status":"PROVIDED","value":"$value","sourceText":"$value"}]}"""))
                .andExpect(status().isOk())
        }
        fun generate(revision: Long): Long {
            val response = mvc.perform(post("$BASE/$id/documents").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
                .content("""{"expectedRevision":$revision}""")).andExpect(status().isOk())
                .andExpect(jsonPath("$[0].fileName").value("신청양식_초안_v$revision.hwpx")).andReturn().response
            return json.readTree(response.contentAsString).path(0).path("id").asLong()
        }
        save(1, "새봄 & 연구소")
        if (blueExamples) {
            mvc.perform(post("$BASE/$id/documents").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
                .content("""{"expectedRevision":2}""")).andExpect(status().is4xxClientError())
            mvc.perform(get("$BASE/$id/documents").cookie(owner)).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0))
        }
        val fileId = generate(2)
        mvc.perform(put("$BASE/$id/progress-stage").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content("""{"expectedProgressRevision":1,"progressStage":"APPLIED"}"""))
            .andExpect(status().isOk()).andExpect(jsonPath("$.inputRevision").value(2))
        mvc.perform(get("$BASE/$id/documents").cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$[0].id").value(fileId))
        assertEquals(fileId, generate(2))
        verify(documentMcp, times(if (blueExamples) 2 else 1)).generate(any(AiDocumentGenerationRequest::class.java) ?: fallback)
        val downloaded = mvc.perform(get("$BASE/$id/documents/$fileId/download").cookie(owner)).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(content().contentType("application/hwp+zip")).andReturn().response.contentAsByteArray
        assertEquals("새봄 & 연구소", documentEditor.inspect(downloaded, "HWPX").targets.single { it.id == target.id }.text)
        if (blueExamples) {
            val reopened = documentEditor.inspect(downloaded, "HWPX").targets
            assertEquals("", reopened.single { it.id == cleanup.single() }.text)
            assertEquals("사업계획서", reopened.single { it.text == "사업계획서" }.exampleText)
        }
        mvc.perform(get("$BASE/$id/documents/$fileId/download").cookie(other)).andExpect(status().isNotFound())
        mvc.perform(get("$BASE/$id/documents/$fileId/download")).andExpect(status().isUnauthorized())
        save(2, "수정한 사업")
        mvc.perform(get("$BASE/$id/documents").cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$.length()").value(1)).andExpect(jsonPath("$[0].id").value(fileId))
        val revised = generate(3)
        org.junit.jupiter.api.Assertions.assertNotEquals(fileId, revised)
        val revisedBytes = mvc.perform(get("$BASE/$id/documents/$revised/download").cookie(owner)).andExpect(status().isOk()).andReturn().response.contentAsByteArray
        assertEquals("수정한 사업", documentEditor.inspect(revisedBytes, "HWPX").targets.single { it.id == target.id }.text)
    }

    @Test
    fun generatesPartialDraftWithoutSendingUnmappedAnswersAndPreservesItsRevisionSnapshot() {
        val original = requireNotNull(javaClass.getResourceAsStream("/combinationreview/general.hwpx")).readBytes()
        val target = documentEditor.inspect(original, "HWPX").targets.first { it.text.isBlank() }
        `when`(bizInfoAttachments.collect("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(SupportProgramAttachments("동적 지원사업", listOf(
            SupportProgramAttachment("https://www.bizinfo.go.kr/file", "신청양식.hwpx", "HWPX", original),
        ), emptyList()))
        `when`(documentParser.parse(original, "HWPX")).thenReturn(listOf(SupportProgramDocumentBlock(DISCOVERY_LOCATOR, DISCOVERY_BLOCK_TEXT)))
        val discovered = json.readValue(resource("discovery-contract-response.json"), AiApplicationFormDiscoveryPayload::class.java)
        val firstField = discovered.forms.single().sections.single().fields.single().copy(required = true)
        val consent = firstField.copy(fieldKey = "privacy-consent", label = "개인정보 동의", guidance = "동의 여부를 입력합니다.",
            required = false, evidenceQuote = "지원 대상")
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscoveryRequest())).thenReturn(discovered.copy(forms = listOf(
            discovered.forms.single().copy(sections = listOf(discovered.forms.single().sections.single().copy(fields = listOf(firstField, consent))))
        )))
        val mappingFallback = AiDocumentMappingRequest(
            sourceBase64 = "", sourceSha256 = "", format = "hwpx", scope = "test", fields = emptyList())
        `when`(documentMcp.map(any(AiDocumentMappingRequest::class.java) ?: mappingFallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiDocumentMappingRequest>(0)
            val placement = ApplicationDocumentPlacement("business-plan:business-overview", target.id)
            AiDocumentMappingPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256,
                "native-map-v2", "test-stub", listOf(placement), listOf(target.id), mapOf(
                    "sourceSha256" to request.sourceSha256,
                    "targets" to listOf(mapOf("targetId" to target.id, "editable" to true, "currentText" to "")),
                    "unmappedFieldIds" to listOf("business-plan:privacy-consent")))
        }
        val generationFallback = AiDocumentGenerationRequest(sourceBase64 = "", sourceSha256 = "", format = "hwpx", answerRevision = 1, facts = emptyList(), scope = "test")
        `when`(documentMcp.generate(any(AiDocumentGenerationRequest::class.java) ?: generationFallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiDocumentGenerationRequest>(0)
            assertEquals(listOf("business-plan:business-overview"), request.facts.map { it.id })
            assertEquals(listOf("business-plan:business-overview"), request.bindings.map { it.factId }.distinct())
            val placement = listOf(ApplicationDocumentPlacement("business-plan:business-overview", target.id))
            val bytes = documentEditor.fill(original, "HWPX", request.facts, placement)
            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            AiDocumentGenerationPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256, request.answerRevision,
                java.util.Base64.getEncoder().encodeToString(bytes), hash, "c".repeat(64), "native-map-v2", "test-stub",
                mapOf("verified" to 1, "unresolved" to 0), placement, emptyMap(), mapOf("answerRevision" to request.answerRevision))
        }

        val discoveryResponse = mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}""")).andExpect(status().isOk()).andReturn().response
        val version = json.readTree(discoveryResponse.contentAsString).path("items").path(0).path("formVersionId").asString()
        activateStored(version)
        val created = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID","formVersionId":"$version","serviceField":"GENERAL"}"""))
            .andExpect(status().isCreated()).andReturn().response
        val id = json.readTree(created.contentAsString).path("id").asLong()
        fun save(revision: Long, overview: String, consentValue: String) {
            mvc.perform(put("$BASE/$id/sections/business-plan/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(mapOf("expectedRevision" to revision, "facts" to listOf(
                    mapOf("fieldKey" to "business-overview", "status" to "PROVIDED", "value" to overview, "sourceText" to overview),
                    mapOf("fieldKey" to "privacy-consent", "status" to "PROVIDED", "value" to consentValue, "sourceText" to consentValue))))))
                .andExpect(status().isOk())
        }
        save(1, "가상기업 홍보 계획", "동의함")
        val generated = mvc.perform(post("$BASE/$id/documents").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":2}""")).andExpect(status().isOk())
            .andExpect(jsonPath("$[0].filledAnswerCount").value(1))
            .andExpect(jsonPath("$[0].unfilledAnswerCount").value(1))
            .andExpect(jsonPath("$[0].unfilledAnswers[0].fieldId").value("business-plan:privacy-consent"))
            .andExpect(jsonPath("$[0].unfilledAnswers[0].fieldLabel").value("사업 계획 / 개인정보 동의"))
            .andExpect(jsonPath("$[0].unfilledAnswers[0].value").value("동의함"))
            .andExpect(jsonPath("$[0].unfilledAnswers[0].reason").value("INPUT_LOCATION_NOT_FOUND"))
            .andReturn().response
        val fileId = json.readTree(generated.contentAsString).path(0).path("id").asLong()
        save(2, "수정한 홍보 계획", "동의하지 않음")
        mvc.perform(get("$BASE/$id/documents").cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$[0].id").value(fileId))
            .andExpect(jsonPath("$[0].inputRevision").value(2))
            .andExpect(jsonPath("$[0].unfilledAnswers[0].value").value("동의함"))
        mvc.perform(get("$BASE/$id/documents").cookie(other)).andExpect(status().isNotFound())
    }

    @Test
    fun doesNotReturnTheOriginalWhenNoSavedAnswerHasAWritableLocation() {
        val original = requireNotNull(javaClass.getResourceAsStream("/combinationreview/general.hwpx")).readBytes()
        `when`(bizInfoAttachments.collect("BIZINFO", DISCOVERY_PROGRAM_ID)).thenReturn(SupportProgramAttachments("동적 지원사업", listOf(
            SupportProgramAttachment("https://www.bizinfo.go.kr/file", "신청양식.hwpx", "HWPX", original),
        ), emptyList()))
        `when`(documentParser.parse(original, "HWPX")).thenReturn(listOf(SupportProgramDocumentBlock(DISCOVERY_LOCATOR, DISCOVERY_BLOCK_TEXT)))
        val discovered = json.readValue(resource("discovery-contract-response.json"), AiApplicationFormDiscoveryPayload::class.java)
        val field = discovered.forms.single().sections.single().fields.single().copy(required = false)
        `when`(ai.discover(any(AiApplicationFormDiscoveryRequest::class.java) ?: fallbackDiscoveryRequest())).thenReturn(discovered.copy(forms = listOf(
            discovered.forms.single().copy(sections = listOf(discovered.forms.single().sections.single().copy(fields = listOf(field))))
        )))
        val mappingFallback = AiDocumentMappingRequest(
            sourceBase64 = "", sourceSha256 = "", format = "hwpx", scope = "test", fields = emptyList())
        `when`(documentMcp.map(any(AiDocumentMappingRequest::class.java) ?: mappingFallback)).thenAnswer { invocation ->
            val request = invocation.getArgument<AiDocumentMappingRequest>(0)
            AiDocumentMappingPayload("application-document-mcp-v1", "b".repeat(64), request.sourceSha256,
                "native-map-v2", "test-stub", emptyList(), emptyList(), mapOf(
                    "sourceSha256" to request.sourceSha256, "targets" to emptyList<Any>(),
                    "unmappedFieldIds" to listOf("business-plan:business-overview")))
        }
        val discoveryResponse = mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}""")).andExpect(status().isOk()).andReturn().response
        val version = json.readTree(discoveryResponse.contentAsString).path("items").path(0).path("formVersionId").asString()
        activateStored(version)
        val created = mvc.perform(post(BASE).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID","formVersionId":"$version","serviceField":"GENERAL"}"""))
            .andExpect(status().isCreated()).andReturn().response
        val id = json.readTree(created.contentAsString).path("id").asLong()
        mvc.perform(put("$BASE/$id/sections/business-plan/inputs").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":1,"facts":[{"fieldKey":"business-overview","status":"PROVIDED","value":"가상 답변","sourceText":"가상 답변"}]}"""))
            .andExpect(status().isOk())
        mvc.perform(post("$BASE/$id/documents").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON)
            .content("""{"expectedRevision":2}""")).andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("APPLICATION_DOCUMENT_NO_WRITABLE_INPUT"))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_file WHERE preparation_id = ?", Int::class.java, id))
        verify(documentMcp, org.mockito.Mockito.never()).generate(any(AiDocumentGenerationRequest::class.java) ?: AiDocumentGenerationRequest(
            sourceBase64 = "", sourceSha256 = "", format = "hwpx", answerRevision = 1, facts = emptyList(), scope = "test"))
    }

    private fun create(session: Cookie, field: String = "TECHNICAL_SUPPORT"): Long {
        val response = mvc.perform(post(BASE).cookie(session).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON).content(payload(field)))
            .andExpect(status().isCreated()).andReturn().response
        return json.readTree(response.contentAsString).path("id").asLong()
    }

    private fun newSession(): Pair<Long, Cookie> {
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.test", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        return account.id to Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }

    private fun payload(field: String = "TECHNICAL_SUPPORT") =
        """{"sourceCode":"BIZINFO","sourceProgramId":"PBLN_000000000118979","formVersionId":"$FORM_VERSION","serviceField":"$field"}"""

    private fun fallbackAiRequest() = AiApplicationPreparationInterpretRequest(
        AI_APPLICATION_PREPARATION_CONTRACT_VERSION,
        1,
        1,
        FORM_VERSION,
        "company-overview",
        "TECHNICAL_SUPPORT",
        "답변",
        emptyList(),
        emptyList(),
    )

    private fun fallbackDiscoveryRequest() = AiApplicationFormDiscoveryRequest(
        AI_APPLICATION_FORM_DISCOVERY_CONTRACT_VERSION,
        "BIZINFO",
        DISCOVERY_PROGRAM_ID,
        "동적 지원사업",
        emptyList(),
    )

    private fun count(): Int = requireNotNull(jdbc.queryForObject("SELECT COUNT(*) FROM application_preparation", Int::class.java))

    private fun resource(name: String) = requireNotNull(
        javaClass.getResourceAsStream("/applicationpreparation/$name"),
    ).bufferedReader().use { it.readText() }

    private companion object {
        const val BASE = "/api/v1/application-preparations"
        const val ORIGIN = "http://localhost:5173"
        const val FORM_VERSION = "bizinfo-pbln-000000000118979-innovation-voucher-2026-v1"
        const val PROMPT_VERSION = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val DISCOVERY_PROMPT_VERSION = "sha256:15eae460de872e14ef6e6a99db4bd5952acc293466adb9492dc34fa51a971c8d"
        const val DISCOVERY_LOCATOR = "HWPX section0 paragraphs 1-2"
        const val DISCOVERY_BLOCK_TEXT = "사업\n개요를 작성해 주세요. 지원 목적과 주요 내용을 구체적으로 설명하고 지원 대상과 기대 효과도 함께 작성해 주세요."
        const val DISCOVERY_PROGRAM_ID = "PBLN_123456"
        const val MSIT_PROGRAM_ID = "3186573"
        const val MSIT_SOURCE_URL = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&mId=311&mPid=121&nttSeqNo=3186573&sCode=user"
        const val KSTARTUP_PROGRAM_ID = "177911"
        const val KSTARTUP_SOURCE_URL = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=177911&schM=view"
        const val CNTRADE_PROGRAM_ID = "3862"
        const val CNTRADE_SOURCE_URL = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
        const val CNTRADE_BODY = "공식 본문"
    }
}
