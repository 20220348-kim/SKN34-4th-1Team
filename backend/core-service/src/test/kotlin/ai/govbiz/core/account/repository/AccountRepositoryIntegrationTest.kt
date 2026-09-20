package ai.govbiz.core.account.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.domain.NewAccountSession
import ai.govbiz.core.account.domain.OAuthLink
import ai.govbiz.core.account.domain.OAuthProvider
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DuplicateKeyException
import org.springframework.jdbc.core.JdbcTemplate

@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
    ],
)
@Import(MySqlTestContainerConfig::class)
class AccountRepositoryIntegrationTest {

    @Autowired
    private lateinit var repository: AccountRepository

    @Autowired
    private lateinit var jdbcTemplate: JdbcTemplate

    @BeforeEach
    fun deleteAccounts() {
        jdbcTemplate.update("DELETE FROM account_session")
        jdbcTemplate.update("DELETE FROM account")
    }

    @Test
    fun createsAnAccountAndReadsItBackByEmailIdAndCredential() {
        val created = createAccountWithSession(newAccount(email = "manager@company.co.kr"), TOKEN_HASH_A, FUTURE)

        assertTrue(created.id > 0)
        assertEquals("manager@company.co.kr", created.email)
        assertEquals(AccountRole.USER, created.role)
        assertFalse(created.isEmailVerified)
        assertFalse(created.isSuspended)
        assertEquals(created, repository.findByEmail("manager@company.co.kr"))
        assertEquals(created, repository.findById(created.id))

        val credential = requireNotNull(repository.findCredentialByEmail("manager@company.co.kr"))
        assertEquals(created, credential.account)
        assertEquals(PASSWORD_HASH, credential.passwordHash)
        assertNull(repository.findByEmail("unknown@company.co.kr"))
    }

    @Test
    fun storesTheVerifiedAdminRoleAndRejectsUnknownRolesAtTheDatabase() {
        val admin = repository.createAccount(
            newAccount(email = "admin@govbiz.local", role = AccountRole.ADMIN).copy(emailVerifiedAt = VERIFIED_AT),
        )

        assertEquals(AccountRole.ADMIN, admin.role)
        assertEquals(VERIFIED_AT, admin.emailVerifiedAt)
        assertTrue(requireNotNull(repository.findByEmail("admin@govbiz.local")).isAdmin)
        assertThrows(Exception::class.java) {
            jdbcTemplate.update(
                "INSERT INTO account (email, password_hash, role, terms_agreed_at) VALUES (?, ?, 'ROOT', ?)",
                "root@govbiz.local",
                PASSWORD_HASH,
                LocalDateTime.of(2026, 9, 6, 12, 0),
            )
        }
    }

    @Test
    fun hidesSoftDeletedAccountsAndKeepsSuspensionVisible() {
        val account = createAccountWithSession(newAccount(email = "gone@company.co.kr"), TOKEN_HASH_A, FUTURE)
        val suspended = repository.createAccount(newAccount(email = "banned@company.co.kr"))

        jdbcTemplate.update("UPDATE account SET deleted_at = NOW(6) WHERE id = ?", account.id)
        jdbcTemplate.update("UPDATE account SET suspended_at = ? WHERE id = ?", SUSPENDED_AT, suspended.id)

        assertNull(repository.findByEmail("gone@company.co.kr"))
        assertNull(repository.findById(account.id))
        assertNull(repository.findCredentialByEmail("gone@company.co.kr"))
        assertNotNull(repository.findSessionByTokenHash(TOKEN_HASH_A))
        assertEquals(SUSPENDED_AT, requireNotNull(repository.findById(suspended.id)).suspendedAt)
        assertTrue(requireNotNull(repository.findByEmail("banned@company.co.kr")).isSuspended)
    }

    @Test
    fun rejectsDuplicateEmailWithoutCreatingASession() {
        createAccountWithSession(newAccount(email = "dup@company.co.kr"), TOKEN_HASH_A, FUTURE)

        assertThrows(DuplicateKeyException::class.java) {
            repository.createAccount(newAccount(email = "dup@company.co.kr"))
        }

        assertEquals(1, countRows("account"))
        assertEquals(1, countRows("account_session"))
        assertNull(repository.findSessionByTokenHash(TOKEN_HASH_B))
    }

    @Test
    fun treatsEmailUniquenessCaseInsensitivelyAtTheDatabase() {
        createAccountWithSession(newAccount(email = "case@company.co.kr"), TOKEN_HASH_A, FUTURE)

        assertThrows(DuplicateKeyException::class.java) {
            jdbcTemplate.update(
                "INSERT INTO account (email, password_hash, terms_agreed_at) " +
                    "SELECT 'CASE@company.co.kr', password_hash, terms_agreed_at FROM account",
            )
        }
    }

    @Test
    fun storesSessionsWithTheirLastUseAndDeletesThemOnLogout() {
        val account = createAccountWithSession(newAccount(email = "session@company.co.kr"), TOKEN_HASH_A, FUTURE)
        repository.createSession(account.id, session(TOKEN_HASH_B, PAST))

        val stored = requireNotNull(repository.findSessionByTokenHash(TOKEN_HASH_A))
        assertEquals(account.id, stored.accountId)
        assertEquals(FUTURE, stored.expiresAt)
        assertTrue(stored.lastUsedAt.isAfter(LocalDateTime.of(2026, 1, 1, 0, 0)))
        // 만료 판단은 Service가 하므로 만료된 행도 그대로 읽힙니다.
        assertEquals(PAST, requireNotNull(repository.findSessionByTokenHash(TOKEN_HASH_B)).expiresAt)
        assertNull(repository.findSessionByTokenHash(TOKEN_HASH_C))

        val touchedAt = LocalDateTime.of(2026, 9, 7, 9, 30, 15)
        repository.touchSession(TOKEN_HASH_A, touchedAt)
        assertEquals(touchedAt, requireNotNull(repository.findSessionByTokenHash(TOKEN_HASH_A)).lastUsedAt)

        assertTrue(repository.deleteSessionByTokenHash(TOKEN_HASH_A))
        assertFalse(repository.deleteSessionByTokenHash(TOKEN_HASH_A))
        assertNull(repository.findSessionByTokenHash(TOKEN_HASH_A))
    }

    @Test
    fun createSessionRemovesExpiredSessionsOfTheSameAccountOnly() {
        val account = createAccountWithSession(newAccount(email = "expiry@company.co.kr"), TOKEN_HASH_A, PAST)
        val other = createAccountWithSession(newAccount(email = "other@company.co.kr"), TOKEN_HASH_B, PAST)

        repository.createSession(account.id, session(TOKEN_HASH_C, FUTURE))

        assertEquals(0, countSessions(TOKEN_HASH_A))
        assertEquals(1, countSessions(TOKEN_HASH_B))
        assertEquals(other, repository.findByEmail("other@company.co.kr"))
        assertEquals(account.id, requireNotNull(repository.findSessionByTokenHash(TOKEN_HASH_C)).accountId)
    }

    @Test
    fun deletingAnAccountCascadesToItsSessions() {
        val account = createAccountWithSession(newAccount(email = "cascade@company.co.kr"), TOKEN_HASH_A, FUTURE)

        jdbcTemplate.update("DELETE FROM account WHERE id = ?", account.id)

        assertEquals(0, countRows("account_session"))
    }

    @Test
    fun rejectsTokenHashesThatAreNotSha256Hex() {
        assertThrows(IllegalArgumentException::class.java) {
            NewAccountSession("not-a-hash", FUTURE)
        }
    }

    @Test
    fun storesPasswordlessSocialAccountsWithTheirProviderLinks() {
        val account = repository.createAccountWithOAuthIdentity(socialAccount("social@kakao.com"), OAuthProvider.KAKAO, KAKAO_SUBJECT)

        assertTrue(account.isEmailVerified)
        assertEquals(account, repository.findByOAuthIdentity(OAuthProvider.KAKAO, KAKAO_SUBJECT))
        assertNull(repository.findByOAuthIdentity(OAuthProvider.GOOGLE, KAKAO_SUBJECT))
        // 비밀번호가 없는 계정은 이메일 로그인 검증 조회에 나오지 않습니다.
        assertNull(repository.findCredentialByEmail("social@kakao.com"))
        assertEquals(listOf(OAuthLink(OAuthProvider.KAKAO, KAKAO_SUBJECT)), repository.findOAuthLinks(account.id))

        assertEquals(0, repository.deleteNonKakaoIdentities(account.id))
        assertEquals(account, repository.findByOAuthIdentity(OAuthProvider.KAKAO, KAKAO_SUBJECT))
        assertFalse(repository.hasPendingOAuthUnlink(OAuthProvider.KAKAO, KAKAO_SUBJECT))
        repository.markDeleted(account.id, LocalDateTime.now())
        assertTrue(repository.hasPendingOAuthUnlink(OAuthProvider.KAKAO, KAKAO_SUBJECT))
    }

    @Test
    fun rollsBackTheNewAccountWhenTheProviderSubjectOrEmailIsAlreadyTaken() {
        repository.createAccountWithOAuthIdentity(socialAccount("first@kakao.com"), OAuthProvider.KAKAO, KAKAO_SUBJECT)
        repository.createAccount(newAccount(email = "taken@company.co.kr"))

        assertThrows(DuplicateKeyException::class.java) {
            repository.createAccountWithOAuthIdentity(socialAccount("second@kakao.com"), OAuthProvider.KAKAO, KAKAO_SUBJECT)
        }
        assertThrows(DuplicateKeyException::class.java) {
            repository.createAccountWithOAuthIdentity(socialAccount("taken@company.co.kr"), OAuthProvider.GOOGLE, "110169484474386276334")
        }

        assertNull(repository.findByEmail("second@kakao.com"))
        assertEquals(2, countRows("account"))
        assertEquals(1, countRows("account_oauth_identity"))
    }

    @Test
    fun hidesTheLinkedAccountOnceDeletedAndCascadesHardDeletesToLinks() {
        val deleted = repository.createAccountWithOAuthIdentity(socialAccount("gone@kakao.com"), OAuthProvider.KAKAO, KAKAO_SUBJECT)
        repository.markDeleted(deleted.id, SUSPENDED_AT)
        assertNull(repository.findByOAuthIdentity(OAuthProvider.KAKAO, KAKAO_SUBJECT))

        jdbcTemplate.update("DELETE FROM account WHERE id = ?", deleted.id)

        assertEquals(0, countRows("account_oauth_identity"))
    }

    private fun socialAccount(email: String): NewAccount =
        NewAccount(email = email, passwordHash = null, termsAgreedAt = VERIFIED_AT, emailVerifiedAt = VERIFIED_AT)

    private fun countRows(table: String): Int =
        requireNotNull(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM $table", Int::class.java))

    private fun countSessions(tokenHash: String): Int =
        requireNotNull(
            jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM account_session WHERE token_hash = ?",
                Int::class.java,
                tokenHash,
            ),
        )

    private fun newAccount(email: String, role: AccountRole = AccountRole.USER): NewAccount =
        NewAccount(
            email = email,
            passwordHash = PASSWORD_HASH,
            termsAgreedAt = LocalDateTime.of(2026, 9, 6, 12, 0),
            role = role,
        )

    private fun session(tokenHash: String, expiresAt: LocalDateTime) = NewAccountSession(tokenHash, expiresAt)

    /** 로그인 흐름과 같이 계정을 만든 뒤 첫 세션을 저장합니다. */
    private fun createAccountWithSession(newAccount: NewAccount, tokenHash: String, expiresAt: LocalDateTime): Account =
        repository.createAccount(newAccount).also { account ->
            repository.createSession(account.id, session(tokenHash, expiresAt))
        }

    private companion object {
        const val PASSWORD_HASH = "\$2a\$10\$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        val TOKEN_HASH_A = "a".repeat(64)
        val TOKEN_HASH_B = "b".repeat(64)
        val TOKEN_HASH_C = "c".repeat(64)
        val FUTURE: LocalDateTime = LocalDateTime.of(2999, 1, 1, 0, 0)
        val PAST: LocalDateTime = LocalDateTime.of(2000, 1, 1, 0, 0)
        val VERIFIED_AT: LocalDateTime = LocalDateTime.of(2026, 9, 6, 12, 30)
        val SUSPENDED_AT: LocalDateTime = LocalDateTime.of(2026, 9, 7, 8, 0)
        const val KAKAO_SUBJECT = "4012345678"
    }
}
