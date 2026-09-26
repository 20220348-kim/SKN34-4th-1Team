package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core._common.test.RedisTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.mockito.Mockito.`when`
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.bean.override.mockito.MockitoBean
import tools.jackson.databind.ObjectMapper

/** Opt-in real TCP Core→AI test. Official attachment acquisition is a fixture; AI Client is real. */
@EnabledIfEnvironmentVariable(named = "DOCX_HTTP_E2E", matches = "true")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false",
    "app.account.cookie-secure=false",
])
@Import(MySqlTestContainerConfig::class, RedisTestContainerConfig::class)
class DocxRealHttpIntegrationTest {
    @LocalServerPort private var port: Int = 0
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var snapshots: ApplicationFormSnapshotRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    @MockitoBean private lateinit var attachments: BizInfoAttachmentClient

    @Test
    fun officialDocxTraversesRealCoreAndAiHttpStorageAndDownload() {
        val source = Files.readAllBytes(Path.of(System.getenv("DOCX_E2E_SOURCE_PATH")))
        val expected = json.readTree(Files.readString(Path.of(System.getenv("DOCX_E2E_EXPECTED_PATH"))))
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(source).joinToString("") { "%02x".format(it) }
        assertEquals(expected.path("sourceSha256").asString(), hash)
        val fields = expected.path("fields").filter { it.has("writeValue") }
        val version = "docx-kotra-http-e2e-${UUID.randomUUID()}"
        val program = "DOCX_HTTP_${UUID.randomUUID()}"
        val form = ApplicationFormManifest(1, version, "BIZINFO", program, "KOTRA HTTP E2E",
            expected.path("scopeTitle").asString(), "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117178",
            "kotra.docx", source.size.toLong(), hash, "SOURCE_HASH_AND_LOCATORS_VERIFIED", false,
            listOf(ApplicationServiceField.GENERAL), fields.groupBy { it.path("id").asString().substringBefore(":") }.map { (section, group) ->
                ApplicationFormSectionDefinition(section, if (section == "company") "기업" else "담당자", "DOCX table 1", "공식 입력칸",
                    group.map { ApplicationFormFieldDefinition(it.path("id").asString().substringAfter(":"),
                        it.path("label").asString(), "공식 신청서의 해당 입력칸", false) })
            })
        snapshots.save(listOf(form), hash, "docx-http-e2e", ApplicationFormDiscoveryConfiguration(
            "application-form-discovery-v1", "fixture", "sha256:" + "a".repeat(64)))
        jdbc.update("""INSERT INTO application_form_availability
            (source_code,source_program_id,catalog_fingerprint,source_fingerprint,parser_version,extraction_model,
             extraction_prompt_version,status,reason_code,active_form_version_id)
            SELECT source_code,source_program_id,source_fingerprint,source_fingerprint,parser_version,extraction_model,
             extraction_prompt_version,'AVAILABLE','FORM_FOUND',form_version_id FROM application_form_snapshot WHERE form_version_id=?""", version)
        `when`(attachments.collect("BIZINFO", program)).thenReturn(SupportProgramAttachments("KOTRA HTTP E2E",
            listOf(SupportProgramAttachment(expected.path("sourceUrl").asString(), "kotra.docx", "DOCX", source)), emptyList()))
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.test", "test-hash", LocalDateTime.now()))
        val session = sessions.issue(account.id, false)
        accounts.createSession(account.id, session.session)
        val client = HttpClient.newHttpClient()
        fun call(method: String, path: String, body: String? = null): HttpResponse<ByteArray> {
            val request = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/application-preparations$path"))
                .header("Cookie", "${SessionCookieHelper.COOKIE_NAME}=${session.sessionToken}")
                .header("Origin", "http://localhost:5173").header("Content-Type", "application/json")
                .method(method, body?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody()).build()
            return client.send(request, HttpResponse.BodyHandlers.ofByteArray())
        }
        val created = call("POST", "", """{"sourceCode":"BIZINFO","sourceProgramId":"$program","formVersionId":"$version","serviceField":"GENERAL"}""")
        assertEquals(201, created.statusCode(), String(created.body()))
        val id = json.readTree(created.body()).path("id").asLong()
        var revision = 1L
        for ((section, group) in fields.groupBy { it.path("id").asString().substringBefore(":") }) {
            val body = json.writeValueAsString(mapOf("expectedRevision" to revision, "facts" to group.map { mapOf(
                "fieldKey" to it.path("id").asString().substringAfter(":"), "status" to "PROVIDED",
                "value" to it.path("writeValue").asString(), "sourceText" to it.path("writeValue").asString()) }))
            val saved = call("PUT", "/$id/sections/$section/inputs", body)
            assertEquals(200, saved.statusCode(), String(saved.body()))
            revision++
        }
        val generated = call("POST", "/$id/documents", """{"expectedRevision":$revision}""")
        assertEquals(200, generated.statusCode(), String(generated.body()))
        val file = json.readTree(generated.body()).path(0)
        assertTrue(file.path("fileName").asString().endsWith(".docx"))
        val downloaded = call("GET", "/$id/documents/${file.path("id").asLong()}/download")
        assertEquals(200, downloaded.statusCode())
        assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            downloaded.headers().firstValue("content-type").orElse(""))
        assertTrue(downloaded.headers().firstValue("content-disposition").orElse("").contains(".docx"))
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_file WHERE preparation_id=?", Int::class.java, id))
        assertNotNull(snapshots.findByVersion(version)?.documentMapSnapshot)
        Files.write(Path.of(System.getenv("DOCX_E2E_OUTPUT_PATH")), downloaded.body())
        println("DOCX_REAL_HTTP_PASS corePort=$port bytes=${downloaded.body().size} writes=${fields.size} revision=$revision")
    }

    companion object {
        @JvmStatic @DynamicPropertySource
        fun ai(registry: DynamicPropertyRegistry) {
            registry.add("app.ai-service.base-url") { System.getenv("DOCX_E2E_AI_URL") }
        }
    }
}
