package ai.govbiz.core.account.helper

import ai.govbiz.core.account.config.AccountSessionProperties
import ai.govbiz.core.account.domain.OAuthProvider
import jakarta.servlet.http.Cookie
import java.time.Clock
import java.time.Duration
import java.util.Base64
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest

class OAuthStateCookieHelperTest {

    private val helper = OAuthStateCookieHelper(AccountTestHelper.sessionProperties(cookieSecure = true), AccountTestHelper.FIXED_CLOCK)

    @Test
    fun issuesAShortLivedHttpOnlyLaxCookieScopedToTheSocialLoginPath() {
        val cookie = helper.issue(transaction())

        assertEquals("govbiz_oauth", cookie.name)
        assertTrue(cookie.isHttpOnly)
        assertTrue(cookie.isSecure)
        assertEquals("Lax", cookie.sameSite)
        assertEquals("/api/v1/auth/oauth", cookie.path)
        assertEquals(Duration.ofMinutes(10), cookie.maxAge)
    }

    @Test
    fun readsBackTheSignedTransaction() {
        assertEquals(transaction(), helper.read(requestWith(helper.issue(transaction()).value)))
        assertNull(helper.read(MockHttpServletRequest()))
    }

    @Test
    fun rejectsForgedForeignAndExpiredValues() {
        val value = helper.issue(transaction()).value
        val signature = value.substringAfter('.')
        val forgedPayload = Base64.getUrlEncoder().withoutPadding().encodeToString(
            """{"p":"kakao","s":"${"s".repeat(43)}","n":"${"n".repeat(43)}","v":"${"v".repeat(43)}","r":"//evil.example","m":true,"e":9999999999}"""
                .toByteArray(),
        )
        val otherSecret = OAuthStateCookieHelper(
            AccountSessionProperties(
                AccountTestHelper.SESSION_TTL, "another-jwt-secret-0123456789abcdef0123", false,
                AccountTestHelper.SESSION_SHORT_TTL, AccountTestHelper.SESSION_IDLE_TTL,
            ),
            AccountTestHelper.FIXED_CLOCK,
        )
        val tenMinutesLater = OAuthStateCookieHelper(
            AccountTestHelper.sessionProperties(),
            Clock.offset(AccountTestHelper.FIXED_CLOCK, OAuthStateCookieHelper.TTL),
        )

        assertNull(helper.read(requestWith("$forgedPayload.$signature")))
        assertNull(helper.read(requestWith("${value.substringBefore('.')}.${"A".repeat(43)}")))
        assertNull(helper.read(requestWith("not-a-cookie")))
        assertNull(otherSecret.read(requestWith(value)))
        assertNull(tenMinutesLater.read(requestWith(value)))
    }

    @Test
    fun expireClearsTheCookieOnTheSamePath() {
        val cookie = helper.expire()

        assertEquals("govbiz_oauth", cookie.name)
        assertEquals("", cookie.value)
        assertEquals("/api/v1/auth/oauth", cookie.path)
        assertEquals(Duration.ZERO, cookie.maxAge)
    }

    private fun requestWith(value: String): MockHttpServletRequest =
        MockHttpServletRequest().apply { setCookies(Cookie(OAuthStateCookieHelper.COOKIE_NAME, value)) }

    private fun transaction() = OAuthStateCookieHelper.Transaction(
        provider = OAuthProvider.GOOGLE,
        state = "s".repeat(43),
        nonce = "n".repeat(43),
        codeVerifier = "v".repeat(43),
        returnPath = "/app/partners?tab=mine",
        rememberMe = true,
        expiresAt = AccountTestHelper.FIXED_CLOCK.instant().plus(OAuthStateCookieHelper.TTL),
    )
}
