package ai.govbiz.core.account.config

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AccountMobileOAuthPropertiesTest {
    @Test
    fun disablesMobileOAuthByDefaultAndAllowsOnlyExactAppOrHttpsCallbacks() {
        assertTrue(AccountMobileOAuthProperties().redirectUris.isEmpty())
        assertEquals(setOf("govbiz://oauth/complete", "https://app.example/oauth/complete"),
            AccountMobileOAuthProperties(listOf("govbiz://oauth/complete", "https://app.example/oauth/complete")).redirectUris)
        listOf("http://app.example/callback", "javascript:alert(1)", "govbiz://oauth", "govbiz://oauth/complete?code=x",
            "govbiz://oauth/complete#fragment", "https://user:password@app.example/callback", "https://*.example/callback").forEach { uri ->
            assertThrows(IllegalArgumentException::class.java) { AccountMobileOAuthProperties(listOf(uri)) }
        }
    }
}
