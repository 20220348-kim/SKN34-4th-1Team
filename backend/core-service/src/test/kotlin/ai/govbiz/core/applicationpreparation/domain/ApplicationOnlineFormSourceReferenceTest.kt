package ai.govbiz.core.applicationpreparation.domain

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class ApplicationOnlineFormSourceReferenceTest {
    @Test
    fun acceptsHttpsReferenceAndRedactsLocation() {
        val reference = ApplicationOnlineFormSourceReference("https://example.com/form?entry=private", "UNKNOWN")
        assertEquals("UNKNOWN", reference.provider)
        assertFalse(reference.toString().contains("private"))
        assertFalse(reference.toString().contains("example.com"))
    }

    @Test
    fun rejectsMalformedOrCredentialBearingReferencesWithoutEchoingUrl() {
        listOf("", " https://example.com/form", "https://example.com/form ", "http://example.com/form",
            "file:///form", "ftp://example.com/form", "jar:file:///form", "data:text/html,form",
            "https:///form", "https://user:secret@example.com/form", "https://example.com:443/form",
            "https://example.com/form#secret", "https://example.com/%secret", "https://example.com/" + "x".repeat(2048),
        ).forEach { url ->
            val error = assertThrows(IllegalArgumentException::class.java) {
                ApplicationOnlineFormSourceReference(url, "GOOGLE_FORMS")
            }
            assertFalse(error.message.orEmpty().contains("secret"))
            assertNull(error.cause)
        }
        listOf("", "google_forms", "GOOGLE FORMS", "X".repeat(65)).forEach { provider ->
            assertThrows(IllegalArgumentException::class.java) {
                ApplicationOnlineFormSourceReference("https://example.com/form", provider)
            }
        }
    }
}