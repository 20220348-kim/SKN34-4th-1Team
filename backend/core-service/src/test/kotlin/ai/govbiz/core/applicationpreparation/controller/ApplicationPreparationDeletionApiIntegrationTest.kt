package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core._common.test.RedisTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormDiscoveryConfiguration
import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import jakarta.servlet.http.Cookie
import java.time.LocalDateTime
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.core.io.ClassPathResource
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import tools.jackson.databind.ObjectMapper

/** QUEUED 삭제 보호만 실행기를 끄고 검사한다. 실제 비동기 생성 테스트의 실행기는 유지한다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.account.cookie-secure=false",
    "app.application-document.jobs.enabled=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class, RedisTestContainerConfig::class)
class ApplicationPreparationDeletionApiIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var snapshots: ApplicationFormSnapshotRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper

    @Test
    fun queuedDocumentJobBlocksDirectDeleteAndPreservesTheOwnedPreparation() {
        val form = ClassPathResource("application-preparation/innovation-voucher-2026-v1.json").inputStream.use {
            json.readValue(it, ApplicationFormManifest::class.java)
        }
        snapshots.save(listOf(form), "a".repeat(64), "test",
            ApplicationFormDiscoveryConfiguration("application-form-discovery-v1", "test-model",
                "sha256:15eae460de872e14ef6e6a99db4bd5952acc293466adb9492dc34fa51a971c8d"))
        jdbc.update("""INSERT INTO application_form_availability
            (source_code, source_program_id, catalog_fingerprint, source_fingerprint, parser_version, extraction_model,
             extraction_prompt_version, status, reason_code, active_form_version_id)
            SELECT source_code, source_program_id, source_fingerprint, source_fingerprint, parser_version, extraction_model,
             extraction_prompt_version, 'AVAILABLE', 'FORM_FOUND', form_version_id
            FROM application_form_snapshot WHERE form_version_id=?
            ON DUPLICATE KEY UPDATE active_form_version_id=VALUES(active_form_version_id), status='AVAILABLE'""", form.formVersionId)
        val (ownerId, owner) = newSession()
        val other = newSession().second
        val base = "/api/v1/application-preparations"
        val origin = "http://localhost:5173"
        val created = mvc.perform(post(base).cookie(owner).header(HttpHeaders.ORIGIN, origin)
            .contentType(MediaType.APPLICATION_JSON)
            .content("""{"sourceCode":"${form.sourceCode}","sourceProgramId":"${form.sourceProgramId}","formVersionId":"${form.formVersionId}","serviceField":"TECHNICAL_SUPPORT"}"""))
            .andExpect(status().isCreated()).andReturn().response
        val id = json.readTree(created.contentAsString).path("id").asLong()
        jdbc.update("""INSERT INTO application_document_generation_job
            (owner_account_id, preparation_id, request_key, expected_revision, created_at)
            VALUES (?, ?, ?, 1, NOW(6))""", ownerId, id, UUID.randomUUID().toString())
        mvc.perform(delete("$base/$id").cookie(other).header(HttpHeaders.ORIGIN, origin))
            .andExpect(status().isNotFound())
        mvc.perform(delete("$base/$id").cookie(owner).header(HttpHeaders.ORIGIN, origin))
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_RUN_CONFLICT"))
        mvc.perform(get("$base/$id").cookie(owner)).andExpect(status().isOk())
        assertEquals("QUEUED", jdbc.queryForObject(
            "SELECT status FROM application_document_generation_job WHERE preparation_id = ?", String::class.java, id))
        jdbc.update("DELETE FROM application_preparation WHERE id = ?", id)
    }

    private fun newSession(): Pair<Long, Cookie> {
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.test", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false)
        accounts.createSession(account.id, issued.session)
        return account.id to Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }
}
