package ai.govbiz.core.chathistory.controller

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.helper.SignupTestHelper
import ai.govbiz.core.chathistory.repository.ChatConversationRepository
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.util.UUID

@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.account.cookie-secure=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class ChatConversationFlowIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var repository: ChatConversationRepository
    @Autowired private lateinit var transaction: TransactionTemplate
    private val emails = mutableMapOf<String, String>()

    @Test
    fun persistsKoreanSnapshotAndRestoresItWithANewSessionWithoutSharingWithAnotherAccount() {
        val email = "${UUID.randomUUID()}@test.local"
        val owner = signup(email)
        val other = signup()
        val snapshot = snapshot("hello", "서울 AI <지원> '사업' 😀")
        save(owner, "hello", 0, snapshot).andExpect(status().isOk()).andExpect(jsonPath("$.version").value(1))
        val secondSession = login(email)
        mvc.perform(get("$path/hello").owner(secondSession)).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.snapshot.messages[0].text").value("서울 AI <지원> '사업' 😀"))
            .andExpect(jsonPath("$.snapshot.pendingClarification").isEmpty)
            .andExpect(jsonPath("$.snapshot.messages[1].programs").isArray)
        mvc.perform(get(path).owner(secondSession)).andExpect(jsonPath("$.items[0].id").value("hello"))
            .andExpect(jsonPath("$.items[0].snapshot").doesNotExist())
        mvc.perform(get("$path/hello").owner(other)).andExpect(status().isNotFound())
        mvc.perform(get(path).owner(other)).andExpect(jsonPath("$.items").isEmpty)
        // 같은 클라이언트 ID여도 소유자가 다르면 별도 기록이며 상대 데이터를 덮지 않습니다.
        save(other, "hello", 0, snapshot("hello", "부산" )).andExpect(status().isOk())
        mvc.perform(get("$path/hello").owner(owner)).andExpect(jsonPath("$.snapshot.messages[0].text").value("서울 AI <지원> '사업' 😀"))
    }

    @Test
    fun rejectsAnonymousWritesMissingOriginAndInvalidSnapshotWithoutCreatingRows() {
        val owner = signup()
        mvc.perform(get(path)).andExpect(status().isUnauthorized())
        mvc.perform(put("$path/a").contentType(MediaType.APPLICATION_JSON).content(body(0, snapshot("a"))))
            .andExpect(status().isUnauthorized())
        mvc.perform(put("$path/a").owner(owner).contentType(MediaType.APPLICATION_JSON).content(body(0, snapshot("a"))))
            .andExpect(status().isForbidden())
        save(owner, "a", 0, snapshot("other")).andExpect(status().isBadRequest())
        save(owner, "a", 0, """{"schemaVersion":2,"messages":[]}""").andExpect(status().isBadRequest())
        save(owner, "a", -1, snapshot("a")).andExpect(status().isBadRequest())
        val tooMany = json.writeValueAsString(mapOf("schemaVersion" to 1, "messages" to (0..200).map { mapOf("id" to "a", "role" to "user", "text" to "질문") }))
        save(owner, "a", 0, tooMany).andExpect(status().isBadRequest())
        val oversized = json.writeValueAsString(mapOf("schemaVersion" to 1, "padding" to "가".repeat(670_000), "messages" to listOf(mapOf("id" to "a", "role" to "user", "text" to "질문"))))
        save(owner, "a", 0, oversized).andExpect(status().isBadRequest())
        mvc.perform(get(path).owner(owner)).andExpect(jsonPath("$.items").isEmpty)
    }

    @Test
    fun rejectsAnOldTabWhenTheSharedBrowserCookieNowBelongsToAnotherAccount() {
        val oldEmail = "${UUID.randomUUID()}@test.local"
        signup(oldEmail)
        val newSession = signup()
        mvc.perform(put("$path/a").cookie(newSession).header(HttpHeaders.ORIGIN, origin)
            .header("X-Chat-Account", oldEmail).contentType(MediaType.APPLICATION_JSON).content(body(0, snapshot("a"))))
            .andExpect(status().isUnauthorized())
        mvc.perform(get(path).cookie(newSession).header("X-Chat-Account", oldEmail)).andExpect(status().isUnauthorized())
        mvc.perform(get(path).owner(newSession)).andExpect(jsonPath("$.items").isEmpty)
    }

    @Test
    fun repeatedSavesAreIdempotentAndStaleVersionsCannotOverwriteNewAnswers() {
        val owner = signup()
        save(owner, "a", 0, snapshot("a")).andExpect(jsonPath("$.version").value(1))
        save(owner, "a", 0, snapshot("a")).andExpect(status().isOk()).andExpect(jsonPath("$.version").value(1))
        save(owner, "a", 1, snapshot("a", "두 번째")).andExpect(jsonPath("$.version").value(2))
        save(owner, "a", 1, snapshot("a", "오래된 창")).andExpect(status().isConflict())
        mvc.perform(get("$path/a").owner(owner)).andExpect(jsonPath("$.snapshot.messages[0].text").value("두 번째"))
        mvc.perform(get(path).owner(owner)).andExpect(jsonPath("$.items.length()").value(1))
    }

    @Test
    fun pagesOldRecordsWithoutDuplicatesWhenANewConversationIsInserted() {
        val owner = signup()
        for (index in 1..32) save(owner, "chat-$index", 0, snapshot("chat-$index")).andExpect(status().isOk())
        val first = mvc.perform(get(path).owner(owner)).andExpect(jsonPath("$.items.length()").value(30))
            .andExpect(jsonPath("$.items[0].id").value("chat-32")).andReturn().response.contentAsString
        val cursor = json.readTree(first).path("nextCursor").asLong()
        save(owner, "latest", 0, snapshot("latest")).andExpect(status().isOk())
        mvc.perform(get(path).param("before", cursor.toString()).owner(owner))
            .andExpect(jsonPath("$.items.length()").value(2)).andExpect(jsonPath("$.items[0].id").value("chat-2"))
            .andExpect(jsonPath("$.nextCursor").isEmpty)
    }

    @Test
    fun accountDeletionRemovesPersonalChatInTheSameTransaction() {
        val email = "${UUID.randomUUID()}@test.local"
        val owner = signup(email)
        save(owner, "a", 0, snapshot("a")).andExpect(status().isOk())
        val accountId = jdbc.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, email)!!
        mvc.perform(delete("/api/v1/me").owner(owner).header(HttpHeaders.ORIGIN, origin)
            .contentType(MediaType.APPLICATION_JSON).content("""{"password":"password1"}""")).andExpect(status().isNoContent())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM chat_conversation WHERE account_id = ?", Int::class.java, accountId))
        val replacement = signup(email)
        mvc.perform(get(path).owner(replacement)).andExpect(jsonPath("$.items").isEmpty)
    }

    @Test
    fun repositorySaveParticipatesInTransactionRollback() {
        val email = "${UUID.randomUUID()}@test.local"
        signup(email)
        val accountId = jdbc.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, email)!!
        assertThrows(IllegalStateException::class.java) {
            transaction.executeWithoutResult {
                repository.save(accountId, "rollback", 0, "서울", snapshot("rollback"))
                throw IllegalStateException("rollback")
            }
        }
        assertEquals(null, repository.find(accountId, "rollback"))
    }

    @Test
    fun deletesOnlyOwnersConversationAndErasesContentWithoutResurrection() {
        val email = "${UUID.randomUUID()}@test.local"
        val owner = signup(email)
        val other = signup()
        save(owner, "shared-id", 0, snapshot("shared-id", "삭제할 개인정보 😀")).andExpect(status().isOk())
        save(owner, "keep", 0, snapshot("keep")).andExpect(status().isOk())
        save(other, "shared-id", 0, snapshot("shared-id", "다른 회원")).andExpect(status().isOk())
        remove(owner, "shared-id").andExpect(status().isNoContent())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")).andExpect(content().string(""))
        remove(owner, "shared-id").andExpect(status().isNoContent())
        mvc.perform(get("$path/shared-id").owner(login(email))).andExpect(status().isNotFound())
        mvc.perform(get(path).owner(owner)).andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].id").value("keep"))
        mvc.perform(get("$path/shared-id").owner(other)).andExpect(jsonPath("$.snapshot.messages[0].text").value("다른 회원"))
        val row = jdbc.queryForMap("SELECT title, CAST(snapshot AS CHAR) AS snapshot, deleted_at FROM chat_conversation WHERE account_id = ? AND conversation_id = ?", accountId(email), "shared-id")
        assertEquals("", row["title"])
        assertEquals("{}", row["snapshot"])
        org.junit.jupiter.api.Assertions.assertNotNull(row["deleted_at"])
        for (version in listOf(0L, 1L, 2L)) save(owner, "shared-id", version, snapshot("shared-id")).andExpect(status().isConflict())
    }

    @Test
    fun deletionBeforeTheFirstSaveBlocksDelayedCreationAndDoesNotExposeOtherOwnersRecord() {
        val owner = signup()
        val other = signup()
        save(other, "pending", 0, snapshot("pending")).andExpect(status().isOk())
        remove(owner, "pending").andExpect(status().isNoContent())
        save(owner, "pending", 0, snapshot("pending")).andExpect(status().isConflict())
        mvc.perform(get(path).owner(owner)).andExpect(jsonPath("$.items").isEmpty)
        mvc.perform(get("$path/pending").owner(other)).andExpect(status().isOk())
    }

    @Test
    fun deletionRequiresSessionSameAccountAndTrustedOrigin() {
        val owner = signup()
        save(owner, "protected", 0, snapshot("protected")).andExpect(status().isOk())
        mvc.perform(delete("$path/protected")).andExpect(status().isUnauthorized())
        mvc.perform(delete("$path/protected").owner(owner)).andExpect(status().isForbidden())
        mvc.perform(delete("$path/protected").owner(owner).header(HttpHeaders.ORIGIN, "https://untrusted.invalid")).andExpect(status().isForbidden())
        mvc.perform(delete("$path/protected").cookie(owner).header("X-Chat-Account", "old@test.local")
            .header(HttpHeaders.ORIGIN, origin)).andExpect(status().isUnauthorized())
        remove(owner, "invalid.id").andExpect(status().isBadRequest())
        mvc.perform(get("$path/protected").owner(owner)).andExpect(status().isOk())
    }

    @Test
    fun deletionParticipatesInRollbackAndAccountRemovalPurgesDeletedMarkers() {
        val email = "${UUID.randomUUID()}@test.local"
        val owner = signup(email)
        save(owner, "rollback-delete", 0, snapshot("rollback-delete")).andExpect(status().isOk())
        val accountId = accountId(email)
        assertThrows(IllegalStateException::class.java) {
            transaction.executeWithoutResult {
                repository.delete(accountId, "rollback-delete")
                throw IllegalStateException("rollback")
            }
        }
        mvc.perform(get("$path/rollback-delete").owner(owner)).andExpect(status().isOk())
        remove(owner, "rollback-delete").andExpect(status().isNoContent())
        mvc.perform(delete("/api/v1/me").owner(owner).header(HttpHeaders.ORIGIN, origin)
            .contentType(MediaType.APPLICATION_JSON).content("""{"password":"password1"}""")).andExpect(status().isNoContent())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM chat_conversation WHERE account_id = ?", Int::class.java, accountId))
    }

    private fun accountId(email: String) = jdbc.queryForObject("SELECT id FROM account WHERE email = ?", Long::class.java, email)!!
    private fun remove(owner: Cookie, id: String) = mvc.perform(delete("$path/$id").owner(owner).header(HttpHeaders.ORIGIN, origin))

    private fun snapshot(id: String, text: String = "서울 AI 지원사업") = json.writeValueAsString(mapOf(
        "schemaVersion" to 1, "messages" to listOf(mapOf("id" to id, "role" to "user", "text" to text),
            mapOf("id" to "$id-answer", "role" to "assistant", "text" to "답변", "programs" to emptyList<String>())),
        "pendingClarification" to null,
    ))
    private fun body(version: Long, snapshot: String) = """{"expectedVersion":$version,"snapshot":$snapshot}"""
    private fun save(owner: Cookie, id: String, version: Long, snapshot: String) = mvc.perform(put("$path/$id").owner(owner)
        .header(HttpHeaders.ORIGIN, origin).contentType(MediaType.APPLICATION_JSON).content(body(version, snapshot)))
    private fun signup(email: String = "${UUID.randomUUID()}@test.local"): Cookie = authenticate("signup", email)
    private fun login(email: String): Cookie = authenticate("login", email)
    private fun authenticate(action: String, email: String): Cookie {
        // 가입은 인증번호를 맞힌 통행 토큰이 있어야 하므로 테스트용 통행 토큰을 먼저 만듭니다.
        val body = if (action == "signup") SignupTestHelper.signupJson(jdbc, email, "password1")
            else """{"email":"$email","password":"password1"}"""
        val response = mvc.perform(post("/api/v1/auth/$action").contentType(MediaType.APPLICATION_JSON)
            .content(body)).andReturn().response
        assertEquals(if (action == "signup") 201 else 200, response.status)
        val cookie = requireNotNull(response.getCookie(SessionCookieHelper.COOKIE_NAME))
        emails[cookie.value] = email
        return cookie
    }
    private fun org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder.owner(cookie: Cookie) =
        cookie(cookie).header("X-Chat-Account", java.net.URLEncoder.encode(requireNotNull(emails[cookie.value]), Charsets.UTF_8))
    companion object { const val path = "/api/v1/me/chat-conversations"; const val origin = "http://localhost:5173" }
}
