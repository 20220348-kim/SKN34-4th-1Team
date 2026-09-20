package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import jakarta.servlet.http.Cookie
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.time.LocalDateTime
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.mockito.Mockito.times
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.json.JsonMapper

/** 실제 HTTP DTO 디코딩·Facade 검증·HWPX 파싱·MySQL 저장을 한 discovery 요청으로 연결합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.account.cookie-secure=false",
    "DOCUMENT_INTERNAL_TOKEN=document-contract-test-token-0123456789",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ApplicationFormDiscoveryContractIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var jdbc: JdbcTemplate
    @MockitoBean private lateinit var details: SupportProgramDetailService
    @MockitoBean private lateinit var attachments: BizInfoAttachmentClient
    private lateinit var owner: Cookie

    @BeforeEach
    fun prepare() {
        jdbc.update("DELETE FROM application_preparation")
        jdbc.update("DELETE FROM application_form_snapshot")
        aiDiscoveryCalls.set(0)
        aiMappingCalls.set(0)
        aiContractFailure.set(null)
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.test", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        owner = Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
        listOf(DISCOVERY_PROGRAM_ID, NO_FORM_PROGRAM_ID, INVALID_AI_PROGRAM_ID, REJECTED_AI_PROGRAM_ID).forEach { sourceProgramId ->
            val program = program(sourceProgramId)
            `when`(details.get("BIZINFO", sourceProgramId)).thenReturn(program)
            `when`(attachments.collect("BIZINFO", sourceProgramId)).thenReturn(
                SupportProgramAttachments(
                    program.title,
                    listOf(SupportProgramAttachment(
                        "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=1",
                        "사업계획서.hwpx",
                        "HWPX",
                        hwpx(),
                    )),
                    emptyList(),
                ),
            )
        }
    }

    @AfterAll
    fun stopAiStub() {
        aiServer.stop(0)
    }

    @Test
    fun discoversThroughTheSharedAiHttpContractPersistsAndReusesTheSnapshot() {
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.cached").value(false))
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].sections[0].fields[0].key").value("business-overview"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
        assertNull(aiContractFailure.get())
        jdbc.update("UPDATE application_form_snapshot SET manifest_json = JSON_SET(manifest_json, '$.sections[0].fields[0].options', JSON_ARRAY('기술', '생활'))")

        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.cached").value(true))
            .andExpect(jsonPath("$.items[0].sections[0].fields[0].options[0]").value("기술"))
            .andExpect(jsonPath("$.items[0].sections[0].fields[0].options[1]").value("생활"))
            .andExpect(jsonPath("$.items.length()").value(1))

        assertEquals(1, aiDiscoveryCalls.get())
        assertEquals(1, aiMappingCalls.get())
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
        verify(attachments, times(2)).collect("BIZINFO", DISCOVERY_PROGRAM_ID)

        // A stored legacy snapshot receives its native map through the real JSON_SET mapper.
        jdbc.update("UPDATE application_form_snapshot SET manifest_json = JSON_REMOVE(manifest_json, '$.documentMapSnapshot')")
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$DISCOVERY_PROGRAM_ID"}"""))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.cached").value(true))
        assertEquals("business-plan:business-overview", jdbc.queryForObject(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.documentMapSnapshot.bindings[0].factId')) FROM application_form_snapshot", String::class.java))
        assertEquals("기술", jdbc.queryForObject(
            "SELECT JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.sections[0].fields[0].options[0]')) FROM application_form_snapshot", String::class.java))
        assertEquals(1, aiDiscoveryCalls.get())
        assertEquals(2, aiMappingCalls.get())
        assertNull(aiContractFailure.get())
    }

    @Test
    fun keepsAValidatedEmptyDiscoveryAsNoForm() {
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$NO_FORM_PROGRAM_ID"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("APPLICATION_FORM_NO_FORM"))

        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
        assertNull(aiContractFailure.get())
    }

    @Test
    fun confirmedAiEvidenceRejectionReachesThePublicContractWithoutSavingAForm() {
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$REJECTED_AI_PROGRAM_ID"}"""))
            .andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("APPLICATION_FORM_AI_INVALID_RESPONSE"))
        assertEquals(1, aiDiscoveryCalls.get())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
    }

    @Test
    fun keepsAnAiContractViolationAsAnInvalidResponse() {
        mvc.perform(post("$BASE/forms/discover").cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"BIZINFO","sourceProgramId":"$INVALID_AI_PROGRAM_ID"}"""))
            .andExpect(status().isBadGateway())
            .andExpect(jsonPath("$.code").value("AI_SERVICE_INVALID_RESPONSE"))

        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_form_snapshot", Int::class.java))
    }

    private fun program(sourceProgramId: String) = SupportProgram(
        sourceProgramId,
        "BIZINFO",
        "동적 지원사업",
        "지원기관",
        "공고 요약",
        emptyList(),
        emptyList(),
        "중소기업",
        "2026-01-01 ~ 2026-12-31",
        null,
        null,
        SupportProgramStatus.OPEN,
        "기업마당",
        "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=$sourceProgramId",
        emptyList(),
    )

    private fun hwpx(): ByteArray = ByteArrayOutputStream().use { bytes ->
        ZipOutputStream(bytes).use { zip ->
            zip.putNextEntry(ZipEntry("Contents/section0.xml"))
            zip.write(
                """<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
                    <hp:p><hp:run><hp:t>사업</hp:t></hp:run></hp:p>
                    <hp:p><hp:run><hp:t>개요를 작성해 주세요. 지원 목적과 주요 내용을 구체적으로 설명하고 지원 대상과 기대 효과도 함께 작성해 주세요.</hp:t></hp:run></hp:p>
                </hp:sec>""".trimIndent().toByteArray(),
            )
            zip.closeEntry()
        }
        bytes.toByteArray()
    }

    private companion object {
        const val BASE = "/api/v1/application-preparations"
        const val ORIGIN = "http://localhost:5173"
        const val DISCOVERY_PROGRAM_ID = "PBLN_123456"
        const val NO_FORM_PROGRAM_ID = "PBLN_123457"
        const val INVALID_AI_PROGRAM_ID = "PBLN_123458"
        const val REJECTED_AI_PROGRAM_ID = "PBLN_123459"
        const val PROMPT_VERSION = "sha256:15eae460de872e14ef6e6a99db4bd5952acc293466adb9492dc34fa51a971c8d"
        val json = JsonMapper.builder().build()
        val aiDiscoveryCalls = AtomicInteger()
        val aiMappingCalls = AtomicInteger()
        val aiContractFailure = AtomicReference<String?>()
        val aiServer: HttpServer = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
            createContext("/internal/v1/application-preparations/document/configuration") { exchange ->
                respond(exchange, """{"contractVersion":"application-document-mcp-v1","pipelineVersion":"${"b".repeat(64)}"}""")
            }
            createContext("/internal/v1/application-preparations/document/map") { exchange ->
                aiMappingCalls.incrementAndGet()
                val request = json.readTree(exchange.requestBody.readNBytes(200_001))
                val source = java.util.Base64.getDecoder().decode(request.path("sourceBase64").asString())
                val hash = java.security.MessageDigest.getInstance("SHA-256").digest(source).joinToString("") { "%02x".format(it) }
                if (exchange.requestHeaders.getFirst("Authorization") != "Bearer document-contract-test-token-0123456789" ||
                    request.path("sourceSha256").asString() != hash || request.has("facts") ||
                    request.path("fields").path(0).path("id").asString() != "business-plan:business-overview") {
                    aiContractFailure.set("document map request did not preserve authentication, source hash or question-only contract")
                    respond(exchange, "{}", 500)
                } else {
                    respond(exchange, """{"contractVersion":"application-document-mcp-v1","pipelineVersion":"${"b".repeat(64)}",
                        "sourceSha256":"$hash","mapVersion":"native-map-v2","engineVersion":"http-contract-stub",
                        "bindings":[{"factId":"business-plan:business-overview","targetId":"p1"}],"scopeTargetIds":["p1"],
                        "documentMap":{"sourceSha256":"$hash","targets":[{"targetId":"p1","editable":true,"currentText":""}]}}""")
                }
            }
            createContext("/internal/v1/application-preparations/discovery/configuration") { exchange ->
                respond(exchange, """{"modelTimeoutSeconds":210,"runTimeoutSeconds":240,"contractVersion":"application-form-discovery-v1","model":"test-model","promptVersion":"$PROMPT_VERSION"}""")
            }
            createContext("/internal/v1/application-preparations/discovery") { exchange ->
                aiDiscoveryCalls.incrementAndGet()
                val request = exchange.requestBody.readNBytes(200_001)
                val requestJson = runCatching { json.readTree(request) }.getOrNull()
                val sourceProgramId = requestJson?.path("sourceProgramId")?.asString()
                if (sourceProgramId == DISCOVERY_PROGRAM_ID) {
                    val expected = json.readTree(resource("discovery-contract-request.json"))
                    val document = requestJson!!.path("documents").path(0)
                    val source = java.util.Base64.getDecoder().decode(document.path("sourceBase64").asString())
                    val hash = java.security.MessageDigest.getInstance("SHA-256").digest(source).joinToString("") { "%02x".format(it) }
                    (expected.path("documents").path(0) as tools.jackson.databind.node.ObjectNode)
                        .put("sourceBase64", document.path("sourceBase64").asString()).put("sourceSha256", hash)
                    if (request.size > 200_000 || requestJson != expected || source.size < 4 || source[0] != 0x50.toByte() || source[1] != 0x4b.toByte()) {
                        aiContractFailure.set("request did not match the shared discovery contract")
                        respond(exchange, "{}", 500)
                    } else {
                        respond(exchange, resource("discovery-contract-response.json"))
                    }
                } else if (sourceProgramId == REJECTED_AI_PROGRAM_ID) {
                    respond(exchange, """{"detail":{"code":"APPLICATION_FORM_AI_INVALID_RESPONSE"}}""", 422)
                } else if (sourceProgramId == NO_FORM_PROGRAM_ID) {
                    respond(
                        exchange,
                        """{"contractVersion":"application-form-discovery-v1","model":"test-model","promptVersion":"$PROMPT_VERSION","forms":[]}""",
                    )
                } else {
                    respond(
                        exchange,
                        resource("discovery-contract-response.json")
                            .replace("\"label\": \"사업 개요\"", "\"label\": {\"unexpected\":true}"),
                    )
                }
            }
            start()
        }

        @JvmStatic
        @DynamicPropertySource
        fun aiServiceProperties(registry: DynamicPropertyRegistry) {
            registry.add("app.ai-service.base-url") { "http://127.0.0.1:${aiServer.address.port}" }
        }

        fun resource(name: String): String = requireNotNull(
            ApplicationFormDiscoveryContractIntegrationTest::class.java.getResourceAsStream("/applicationpreparation/$name"),
        ).bufferedReader().use { it.readText() }

        fun respond(exchange: HttpExchange, body: String, status: Int = 200) {
            val bytes = body.toByteArray()
            exchange.responseHeaders.set("Content-Type", "application/json")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }
}
