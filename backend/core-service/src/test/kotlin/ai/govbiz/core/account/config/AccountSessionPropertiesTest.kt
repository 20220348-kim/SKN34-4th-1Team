package ai.govbiz.core.account.config

import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.NullSource
import org.junit.jupiter.params.provider.ValueSource

class AccountSessionPropertiesTest {

    @Test
    fun trimsTheJwtSecretAndDefaultsTheShortAndIdleTtls() {
        val properties = AccountSessionProperties(Duration.ofDays(30), "  0123456789abcdef0123456789abcdef  ")

        assertEquals(Duration.ofDays(30), properties.sessionTtl)
        assertEquals(Duration.ofHours(12), properties.sessionShortTtl)
        assertEquals(Duration.ofDays(7), properties.sessionIdleTtl)
        assertEquals("0123456789abcdef0123456789abcdef", properties.jwtSecret)
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = ["", "   ", "short-secret", "0123456789abcdef0123456789abcde"])
    fun rejectsAMissingOrShortJwtSecret(secret: String?) {
        val exception = assertThrows(IllegalArgumentException::class.java) {
            AccountSessionProperties(Duration.ofDays(30), secret)
        }

        assertEquals("app.account.jwt-secret must be at least 32 characters", exception.message)
    }

    @Test
    fun rejectsNonPositiveTtls() {
        assertEquals(
            "app.account.session-ttl must be greater than zero",
            assertThrows(IllegalArgumentException::class.java) {
                AccountSessionProperties(Duration.ZERO, SECRET)
            }.message,
        )
        assertEquals(
            "app.account.session-short-ttl must be greater than zero",
            assertThrows(IllegalArgumentException::class.java) {
                AccountSessionProperties(Duration.ofDays(30), SECRET, null, Duration.ZERO)
            }.message,
        )
        assertEquals(
            "app.account.session-idle-ttl must be greater than zero",
            assertThrows(IllegalArgumentException::class.java) {
                AccountSessionProperties(Duration.ofDays(30), SECRET, null, null, Duration.ofSeconds(-1))
            }.message,
        )
    }

    private companion object {
        const val SECRET = "0123456789abcdef0123456789abcdef"
    }
}
