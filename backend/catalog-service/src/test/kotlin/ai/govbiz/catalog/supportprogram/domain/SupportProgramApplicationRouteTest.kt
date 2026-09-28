package ai.govbiz.catalog.supportprogram.domain

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SupportProgramApplicationRouteTest {
    @Test
    fun classifiesOnlyResponderGooglePaths() {
        for (url in listOf(
            "https://docs.google.com/forms/d/e/abc_123/viewform",
            "https://forms.gle/abc_123",
        )) {
            assertEquals(SupportProgramApplicationRouteType.GOOGLE_FORMS,
                SupportProgramApplicationRoute.fromOfficialFields("온라인 접수", url).type)
        }
        for (url in listOf(
            "https://docs.google.com/forms/d/e/abc_123/edit",
            "https://docs.google.com/forms/d/e/abc_123/formResponse",
        )) {
            val route = SupportProgramApplicationRoute.fromOfficialFields("온라인 접수", url)
            assertEquals(SupportProgramApplicationRouteType.UNKNOWN, route.type)
            assertNull(route.url)
        }
    }

    @Test
    fun classifiesOfficialApplicationUrlAndExplicitSubmissionMethod() {
        val online = SupportProgramApplicationRoute.fromOfficialFields("홈페이지 신청", "https://apply.example.go.kr/apply")
        assertEquals(SupportProgramApplicationRouteType.OTHER_ONLINE_FORM, online.type)
        val file = SupportProgramApplicationRoute.fromOfficialFields("신청서 작성 후 이메일 제출", null)
        assertEquals(SupportProgramApplicationRouteType.FILE, file.type)
        assertEquals("신청서 작성 후 이메일 제출", file.method)
    }

    @Test
    fun preservesUnknownWithoutUsingTheAnnouncementUrlAsFallback() {
        val missing = SupportProgramApplicationRoute.fromOfficialFields(null, null)
        assertEquals(SupportProgramApplicationRouteType.UNKNOWN, missing.type)
        assertNull(missing.url)
        assertEquals(SupportProgramApplicationRouteType.UNKNOWN,
            SupportProgramApplicationRoute.fromOfficialFields("별도 문의", null).type)
    }

    @Test
    fun rejectsUnsafeApplicationUrlsWithoutFetchingThem() {
        for (url in listOf(
            "http://apply.example.go.kr", "javascript:alert(1)", "data:text/plain,hello",
            "https://user:password@apply.example.go.kr", "https:///apply",
            "https://apply.example.go.kr/\n", "https://apply.example.go.kr/" + "a".repeat(2048),
        )) {
            val route = SupportProgramApplicationRoute.fromOfficialFields("온라인 접수", url)
            assertEquals(SupportProgramApplicationRouteType.UNKNOWN, route.type)
            assertNull(route.url)
        }
    }

    @Test
    fun rejectsOversizedMethodInsteadOfTruncatingIt() {
        assertThrows(IllegalArgumentException::class.java) {
            SupportProgramApplicationRoute.fromOfficialFields("가".repeat(3000), null)
        }
    }
}
