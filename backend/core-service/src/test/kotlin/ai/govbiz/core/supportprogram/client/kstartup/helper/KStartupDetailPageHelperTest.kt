package ai.govbiz.core.supportprogram.client.kstartup.helper

import java.net.URI
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KStartupDetailPageHelperTest {

    @Test
    fun acceptsOnlyOfficialHttpsDetailPagesOfTheRequestedProgram() {
        listOf(
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=$ID",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-deadline.do?pbancSn=$ID&schM=view",
            "https://k-startup.go.kr:443/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
        ).forEach { value ->
            assertTrue(KStartupDetailPageHelper.isDetailUri(URI(value), ID), value)
        }
    }

    @Test
    fun rejectsOtherHostsPathsProgramsAndUnexpectedQueryParameters() {
        listOf(
            "http://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
            "https://www.k-startup.go.kr.attacker.test/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
            "https://attacker.test/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
            "https://user@www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
            "https://www.k-startup.go.kr:444/web/contents/bizpbanc-ongoing.do?pbancSn=$ID",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID#files",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-list.do?pbancSn=$ID",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=177423",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID&pbancSn=$ID",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID&page=2",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$ID&schM=list",
            "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do",
        ).forEach { value ->
            assertFalse(KStartupDetailPageHelper.isDetailUri(URI(value), ID), value)
        }
    }

    @Test
    fun readsTheStatusPageHandoffFromTheOngoingPageScript() {
        val html = """
            <script>
              var fullUrl = '/web/contents/bizpbanc-deadline.do?schM=view&amp;pbancSn=$ID';
              url = new URL(fullUrl);
            </script>
        """.trimIndent()

        assertEquals("/web/contents/bizpbanc-deadline.do?schM=view&pbancSn=$ID", KStartupDetailPageHelper.fullUrl(html))
        assertEquals(
            "https://www.k-startup.go.kr/x",
            KStartupDetailPageHelper.fullUrl("<script>var fullUrl=\"https://www.k-startup.go.kr/x\";</script>"),
        )
        assertNull(KStartupDetailPageHelper.fullUrl("<div id=\"scrTitle\"><h3>공고</h3></div>"))
    }

    private companion object {
        const val ID = "178927"
    }
}
