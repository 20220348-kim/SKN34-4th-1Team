package ai.govbiz.core.account.helper

import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import jakarta.servlet.http.Cookie
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.mock.web.MockHttpServletRequest

class SessionRequestTokenHelperTest {
    @Test
    fun readsExplicitBearerAndPrefersWebCookieWhenBothExist() {
        val request = MockHttpServletRequest()
        assertNull(SessionRequestTokenHelper.read(request))
        request.addHeader(HttpHeaders.AUTHORIZATION, "bEaReR native-token")
        assertEquals("native-token", SessionRequestTokenHelper.read(request))
        request.setCookies(Cookie(SessionCookieHelper.COOKIE_NAME, "web-token"))
        assertEquals("web-token", SessionRequestTokenHelper.read(request))
    }

    @Test
    fun rejectsMalformedAndDuplicateAuthorizationInsteadOfTreatingItAsAnonymous() {
        listOf("", "Basic token", "Bearer", "Bearer ", "Bearer first second", "Bearer a,b", "Bearer token\n").forEach { value ->
            val request = MockHttpServletRequest().apply { addHeader(HttpHeaders.AUTHORIZATION, value) }
            assertThrows(AuthenticationRequiredException::class.java) { SessionRequestTokenHelper.read(request) }
        }
        val repeated = MockHttpServletRequest().apply {
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer first")
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer second")
        }
        assertThrows(AuthenticationRequiredException::class.java) { SessionRequestTokenHelper.read(repeated) }
    }
}
