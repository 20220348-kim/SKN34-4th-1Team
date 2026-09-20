package ai.govbiz.core.supportprogram.client.bizinfo.mapper

import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BizInfoSourceDocumentMapperTest {

    @Test
    fun extractsOnlyTheOfficialDetailContentFromRepeatedBodyTagsAndNestedMarkup() {
        // 실제 기업마당처럼 여러 문서/body가 이어지고 추천 공고가 뒤에 붙는 구조입니다.
        val html = """
            <html><body></body></html>
            <html><body><div class="header">로그인과 메뉴</div></body></html>
            <html><body>
              ${detailHtml("<form><p>$CONTENT</p><p>신청 방법: 온라인 접수</p><script>secret-token</script></form>")}
              <div class="similar_announcement">다른 공고의 접수 마감일은 2027년 12월입니다.</div>
              <div class="footer">기업마당 푸터</div>
            </body></html>
        """.trimIndent()
        val program = catalogProgram("PBLN_1").program

        val document = BizInfoSourceDocumentMapper.fromHtml(program, html, FETCHED_AT)

        val expected = "공고명: PBLN_1 지원사업\n공식 원문: ${program.sourceUrl}\n\n" +
            "$CONTENT\n\n신청 방법: 온라인 접수"
        assertEquals("BIZINFO:PBLN_1", document.sourceQualifiedId)
        assertEquals(FETCHED_AT, document.fetchedAt)
        assertEquals(expected, document.content)
        assertEquals(SupportProgramContentHashHelper.sha256(expected), document.contentHash)
        assertFalse(document.content.contains("다른 공고"))
        assertFalse(document.content.contains("로그인"))
        assertFalse(document.content.contains("secret-token"))
        assertFalse(document.content.contains("푸터"))
    }

    @Test
    fun preservesHtmlEntitiesAndReadableTextAcrossNestedElements() {
        val document = BizInfoSourceDocumentMapper.fromHtml(
            catalogProgram("PBLN_1").program,
            detailHtml("<p>$CONTENT</p><table><tr><th>지원 분야</th><td>AI &amp; 기술 &lt;개발&gt;</td></tr></table>"),
            FETCHED_AT,
        )

        assertTrue(document.content.contains("AI & 기술 <개발>"))
        assertTrue(document.content.contains("지원 분야\n\nAI"))
    }

    @Test
    fun rejectsMissingDetailSectionsShortContentAndOversizedContent() {
        val invalidHtml = listOf(
            "<main><h1>PBLN_1 지원사업</h1>$CONTENT</main>",
            detailHtml("너무 짧은 원문"),
            detailHtml("가".repeat(30_001)),
        )
        invalidHtml.forEach { html ->
            assertThrows(IllegalArgumentException::class.java) {
                BizInfoSourceDocumentMapper.fromHtml(catalogProgram("PBLN_1").program, html, FETCHED_AT)
            }
        }
    }

    @Test
    fun removesUnsupportedCharactersFromBothTitleAndContentBeforeTheAiBoundary() {
        val document = BizInfoSourceDocumentMapper.fromHtml(
            catalogProgram("PBLN_1").program.copy(title = "PBLN_1\u200B 지원사업"),
            detailHtml("<p>서울\u200BAI🙂</p><p>$CONTENT</p>"),
            FETCHED_AT,
        )

        assertTrue(document.content.contains("서울AI🙂"))
        assertFalse(Regex("\\p{C}").containsMatchIn(document.content.replace("\n", "")))
    }

    @Test
    fun rejectsAnotherProgramEvenIfTheRequestedTitleAppearsElsewhereInThePage() {
        assertThrows(IllegalArgumentException::class.java) {
            BizInfoSourceDocumentMapper.fromHtml(
                catalogProgram("PBLN_1").program,
                "<title>PBLN_1 지원사업</title>" + detailHtml(CONTENT, "다른 공고"),
                FETCHED_AT,
            )
        }
    }

    private fun detailHtml(contents: String, title: String = "PBLN_1 지원사업") = """
        <div class="support_project_detail">
          <div class="title_area"><div><h2 class="title">$title</h2></div></div>
          <div class="view_cont">$contents</div>
          <div class="modal_pblancNm_title">해시태그 팝업</div>
        </div>
    """.trimIndent()

    private companion object {
        val FETCHED_AT: LocalDateTime = LocalDateTime.of(2026, 9, 5, 10, 30)
        const val CONTENT = "서울 AI 기업은 기술 개발과 사업화를 위한 자금과 전문가 컨설팅을 지원받을 수 있습니다. 신청 기업은 접수 기간 안에 사업계획서와 필수 증빙 서류를 온라인으로 제출해야 하며, 선정 결과는 별도 안내됩니다."
    }
}
