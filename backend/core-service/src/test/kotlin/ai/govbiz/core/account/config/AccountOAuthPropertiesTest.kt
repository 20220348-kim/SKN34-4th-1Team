package ai.govbiz.core.account.config

import ai.govbiz.core.account.domain.OAuthProvider
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AccountOAuthPropertiesTest {

    @Test
    fun buildsTheRegisteredCallbackAndStartUrisOnTheCallbackOrigin() {
        val properties = AccountOAuthProperties(callbackBaseUrl = "https://govbiz.example/", frontendBaseUrl = "https://govbiz.example")

        assertEquals("https://govbiz.example/api/v1/auth/oauth/kakao/callback", properties.callbackUri(OAuthProvider.KAKAO))
        assertEquals("https://govbiz.example/api/v1/auth/oauth/google/authorize", properties.startUri(OAuthProvider.GOOGLE))
        assertEquals("https://govbiz.example", properties.frontendBaseUrl)
    }

    @Test
    fun enablesAProviderOnlyWithBothClientIdAndSecret() {
        assertFalse(AccountOAuthProperties().google.isConfigured)
        assertFalse(AccountOAuthProperties.ClientCredentials(clientId = "id", clientSecret = " ").isConfigured)
        assertTrue(AccountOAuthProperties.KakaoCredentials(clientId = "id", clientSecret = "secret").isConfigured)
    }

    @Test
    fun rejectsOriginsWithPathsAndPlainHttpOutsideLoopback() {
        listOf("http://govbiz.example", "https://govbiz.example/app", "https://govbiz.example?x=1", "not a url").forEach { origin ->
            assertThrows(IllegalArgumentException::class.java) { AccountOAuthProperties(callbackBaseUrl = origin) }
            assertThrows(IllegalArgumentException::class.java) { AccountOAuthProperties(frontendBaseUrl = origin) }
        }
        AccountOAuthProperties(callbackBaseUrl = "http://localhost:5173", frontendBaseUrl = "http://127.0.0.1:5173")
    }
}
