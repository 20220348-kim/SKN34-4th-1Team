package ai.govbiz.core.supportprogram.client.document.helper

import org.jsoup.Jsoup
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SupportProgramReadableTextHelperTest {

    @Test
    fun turnsBlockBoundariesIntoLinesAndDropsScriptsInputsAndHiddenElements() {
        val contents = Jsoup.parse(
            """
            <div id="contents">
              <h2>지원 대상</h2>
              <p>서울&nbsp;소재   중소기업<br>예비창업자 포함</p>
              <table><tr><th>지원 분야</th><td>AI &amp; 기술 &lt;개발&gt;</td></tr></table>
              <ul><li>사업계획서</li><li>사업자등록증</li></ul>
              <script>var token = 'secret';</script><button>신청하기</button><input value="입력값"><p hidden>숨김</p>
            </div>
            """.trimIndent(),
        ).selectFirst("#contents")!!

        val text = SupportProgramReadableTextHelper.extractReadableText(contents)

        assertEquals(
            "지원 대상\n\n서울 소재 중소기업\n\n예비창업자 포함\n\n지원 분야\n\nAI & 기술 <개발>\n\n사업계획서\n\n사업자등록증",
            text,
        )
        // 원본 문서는 바꾸지 않습니다.
        assertTrue(contents.selectFirst("script") != null)
    }

    @Test
    fun removesControlFormatAndPrivateUseCharactersButKeepsReadableSymbols() {
        val contents = Jsoup.parse("<div id='c'><p>﻿서울​AI\u0007🙂 ○ 접수</p></div>").selectFirst("#c")!!

        assertEquals("서울AI🙂 ○ 접수", SupportProgramReadableTextHelper.extractReadableText(contents))
    }

    @Test
    fun normalizesTitlesForComparisonWithoutDroppingPunctuation() {
        assertEquals(
            "2026 'IR' 데모데이 (예비) & 모집",
            SupportProgramReadableTextHelper.normalizeForComparison("  2026　'IR'​ 데모데이 \n(예비) &amp; 모집 "),
        )
        assertEquals("ABC 123", SupportProgramReadableTextHelper.normalizeForComparison("ＡＢＣ　１２３"))
    }
}
