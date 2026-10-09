package ai.govbiz.core.supportprogram.client.kstartup.mapper

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KStartupSourceDocumentMapperTest {

    private val program: SupportProgram = catalogProgram("178927").program.copy(
        sourceCode = "KSTARTUP",
        title = "2026 소셜임팩트 'IR' 데모데이 참가기업 모집",
        sourceName = "K-Startup",
        sourceUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178927",
    )

    @Test
    fun keepsTheOfficialSectionsAndDropsSiteChromeFilesAndHiddenElements() {
        val document = KStartupSourceDocumentMapper.fromHtml(program, page(), FETCHED_AT)

        assertEquals("KSTARTUP:178927", document.sourceQualifiedId)
        assertEquals(program.sourceUrl, document.sourceUrl)
        assertEquals(FETCHED_AT, document.fetchedAt)
        assertEquals(SupportProgramContentHashHelper.sha256(document.content), document.contentHash)
        assertTrue(
            document.content.startsWith(
                "공고명: 2026 소셜임팩트 \"IR\" 데모데이 참가기업 모집\n공식 원문: ${program.sourceUrl}\n\n",
            ),
        )
        listOf(
            "지원분야", "행사ㆍ네트워크", "신청방법 및 대상", "이메일 접수", "제출서류", "참가신청서 1부, 발표자료 1부",
            "선정절차 및 평가방법", "서면평가 후 본선 발표", "지원내용", "우수 기업 직접 투자 검토", "문의처",
        ).forEach { expected -> assertTrue(document.content.contains(expected), expected) }
        listOf(
            "로그인 메뉴", "공통 유의사항", "신청서.hwp", "다운로드", "공공누리", "목록", "secretToken",
            "숨김 안내", "hidden 속성", "사이트 푸터",
        ).forEach { unexpected -> assertFalse(document.content.contains(unexpected), unexpected) }
    }

    @Test
    fun producesTheSameHeaderAndBlockLayoutAsTheBizInfoSourceDocument() {
        val document = KStartupSourceDocumentMapper.fromHtml(
            program,
            """
                <div class="app_notice_details-wrap">
                  <div id="scrTitle"><h3>2026 소셜임팩트 "IR" 데모데이 참가기업 모집</h3></div>
                  <div class="information_list"><p class="title">제출서류</p><p class="list">$SUBMISSION</p></div>
                  <div class="board_file"><a class="file_bg">신청서.hwp</a></div>
                </div>
            """.trimIndent(),
            FETCHED_AT,
        )

        val expected = "공고명: 2026 소셜임팩트 \"IR\" 데모데이 참가기업 모집\n공식 원문: ${program.sourceUrl}\n\n" +
            "2026 소셜임팩트 \"IR\" 데모데이 참가기업 모집\n\n제출서류\n\n$SUBMISSION"
        assertEquals(expected, document.content)
        assertEquals(SupportProgramContentHashHelper.sha256(expected), document.contentHash)
    }

    @Test
    fun acceptsTitlesThatDifferOnlyInWhitespaceQuotesOrPunctuation() {
        listOf(
            "2026 소셜임팩트 \"IR\" 데모데이 참가기업 모집",
            "2026  소셜임팩트 “IR” 데모데이,  참가기업 모집",
            "2026 소셜임팩트 IR 데모데이 참가기업 모집!",
        ).forEach { title ->
            val document = KStartupSourceDocumentMapper.fromHtml(program, page(title), FETCHED_AT)
            assertEquals("KSTARTUP:178927", document.sourceQualifiedId)
        }
    }

    @Test
    fun rejectsAnotherProgramMissingTitleOrMissingDetailSection() {
        val invalidHtml = listOf(
            page("2027 소셜임팩트 'IR' 데모데이 참가기업 모집"),
            page(""),
            page("...!"),
            "<main><div id=\"scrTitle\"><h3>${program.title}</h3></div><p>$SUBMISSION $SUBMISSION</p></main>",
        )

        invalidHtml.forEach { html ->
            assertThrows(IllegalArgumentException::class.java) {
                KStartupSourceDocumentMapper.fromHtml(program, html, FETCHED_AT)
            }
        }
    }

    @Test
    fun rejectsTooShortAndOversizedReadableText() {
        listOf(
            detail("<p>짧은 본문</p>"),
            detail("<p>${"가".repeat(30_001)}</p>"),
        ).forEach { html ->
            assertThrows(IllegalArgumentException::class.java) {
                KStartupSourceDocumentMapper.fromHtml(program, html, FETCHED_AT)
            }
        }
    }

    @Test
    fun stripsControlAndFormatCharactersFromTitleAndContent() {
        val document = KStartupSourceDocumentMapper.fromHtml(
            program.copy(title = "2026 소셜임팩트\u200B 'IR' 데모데이 참가기업 모집"),
            detail("<p>\uFEFF○ 제출 방식: 이메일\u0007 접수\u200B</p><p>$SUBMISSION</p>"),
            FETCHED_AT,
        )

        assertTrue(document.content.contains("○ 제출 방식: 이메일 접수"))
        assertFalse(Regex("\\p{C}").containsMatchIn(document.content.replace("\n", "")))
    }

    private fun detail(body: String, title: String = program.title) =
        "<div class=\"app_notice_details-wrap\"><div id=\"scrTitle\"><h3>$title</h3></div>$body</div>"

    private fun page(title: String = "2026 소셜임팩트 \"IR\" 데모데이 참가기업 모집") = """
        <html><body>
          <div class="header">로그인 메뉴</div>
          <div class="content_wrap"><div class="content">
            <div class="app_notice_details-wrap type2">
              <div class="information_box-wrap">
                <div class="title_wrap"><div class="title" id="scrTitle"><h3>$title</h3></div></div>
                <div class="bg_box"><ul class="dot_list-wrap"><li class="dot_list bl02"><div class="table_inner">
                  <p class="tit">지원분야</p><p class="txt">행사ㆍ네트워크</p>
                </div></li></ul></div>
              </div>
              <div class="information_list-wrap">
                <div class="information_list"><p class="title">신청방법 및 대상</p>
                  <ul class="dot_list-wrap"><li class="dot_list"><div class="table_inner"><p class="tit">신청방법</p><div class="txt"><p>이메일 접수</p></div></div></li></ul>
                </div>
                <div class="information_list"><p class="title">제출서류</p>
                  <ul class="dot_list-wrap"><li class="dot_list"><p class="tit">참가신청서 1부, 발표자료 1부</p><div class="list_wrap"><p class="list">$SUBMISSION</p></div></li></ul>
                </div>
                <div class="information_list"><p class="title">선정절차 및 평가방법</p><p class="list">서면평가 후 본선 발표</p></div>
                <div class="information_list"><p class="title">지원내용</p><p class="list">우수 기업 직접 투자 검토</p></div>
                <div class="information_list"><p class="title">문의처</p><p class="list">운영 사무국 이메일 문의</p></div>
              </div>
              <div class="guide_wrap"><p class="guide_txt">공통 유의사항 안내</p></div>
              <div class="board_file"><ul><li class="clear"><a class="file_bg">신청서.hwp</a>
                <a href="/afile/fileDownload/abc" class="btn_down" name="downloadBtn"><span>다운로드</span></a></li></ul></div>
              <div class="copy_right_wrap"><div class="inner"><p>공공누리 제1유형 저작물 표시</p></div></div>
              <div class="lower_btn-wrap"><a href="javascript:goList();" class="btn_list"><span>목록</span></a></div>
              <script>var secretToken = 'abc';</script>
              <p style="DISPLAY: none">숨김 안내 문구</p>
              <p hidden>hidden 속성 문구</p>
            </div>
          </div></div>
          <footer>사이트 푸터</footer>
        </body></html>
    """.trimIndent()

    private companion object {
        val FETCHED_AT: LocalDateTime = LocalDateTime.of(2026, 9, 5, 10, 30)
        const val SUBMISSION = "제출 서류 전체를 하나의 압축파일로 묶어 이메일로 제출합니다. 서면평가를 통과한 기업에는 본선 발표 일정을 개별 안내합니다."
    }
}
