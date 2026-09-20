package ai.govbiz.core.account.helper

import java.time.Instant
import java.util.Base64
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class SessionTokenHelperTest {

    @Test
    fun issuesAThreePartHs256JwtWhoseClaimsVerifyWithTheSameSecret() {
        val first = SessionTokenHelper.issue(7L, ISSUED_AT, EXPIRES_AT, SECRET)
        val second = SessionTokenHelper.issue(7L, ISSUED_AT, EXPIRES_AT, SECRET)

        assertTrue(Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+").matches(first))
        assertNotEquals(first, second)
        assertEquals("""{"alg":"HS256","typ":"JWT"}""", decodePart(first, 0))
        assertTrue(decodePart(first, 1).contains(""""sub":"7""""))

        val claims = requireNotNull(SessionTokenHelper.verify(first, SECRET, ISSUED_AT))
        assertEquals(7L, claims.accountId)
        assertEquals(ISSUED_AT, claims.issuedAt)
        assertEquals(EXPIRES_AT, claims.expiresAt)
        assertEquals(64, SessionTokenHelper.hash(first).length)
    }

    @Test
    fun rejectsATokenSignedWithAnotherSecretOrTamperedPayload() {
        val token = SessionTokenHelper.issue(7L, ISSUED_AT, EXPIRES_AT, SECRET)
        val parts = token.split('.')
        val tamperedPayload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"sub":"8","iat":${ISSUED_AT.epochSecond},"exp":${EXPIRES_AT.epochSecond}}""".toByteArray())

        assertNull(SessionTokenHelper.verify(token, "another-secret-that-is-long-enough-000", ISSUED_AT))
        assertNull(SessionTokenHelper.verify("${parts[0]}.$tamperedPayload.${parts[2]}", SECRET, ISSUED_AT))
    }

    @Test
    fun rejectsAnExpiredToken() {
        val token = SessionTokenHelper.issue(7L, ISSUED_AT, EXPIRES_AT, SECRET)

        assertNull(SessionTokenHelper.verify(token, SECRET, EXPIRES_AT))
        assertNull(SessionTokenHelper.verify(token, SECRET, EXPIRES_AT.plusSeconds(1)))
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "",
            "not-a-jwt",
            "a.b",
            "a.b.c",
            "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiI3In0.",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.!!!.!!!",
        ],
    )
    fun rejectsMalformedTokensAndOtherAlgorithms(token: String) {
        assertNull(SessionTokenHelper.verify(token, SECRET, ISSUED_AT))
    }

    private fun decodePart(token: String, index: Int): String =
        String(Base64.getUrlDecoder().decode(token.split('.')[index]))

    private companion object {
        const val SECRET = "test-jwt-secret-0123456789abcdef0123456789"
        val ISSUED_AT: Instant = Instant.parse("2026-09-06T03:00:00Z")
        val EXPIRES_AT: Instant = Instant.parse("2026-10-06T03:00:00Z")
    }
}
