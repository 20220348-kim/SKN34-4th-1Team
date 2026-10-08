package ai.govbiz.core.supportprogram.client.document.helper

import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramEvidenceLayoutHelper.PdfLine
import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramEvidenceLayoutHelper.PdfPage
import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramEvidenceLayoutHelper.PdfWord
import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SupportProgramEvidenceLayoutHelperTest {
    private val helper = SupportProgramEvidenceLayoutHelper

    /** 글자 폭 7, 낱말 사이 5인 한 줄입니다. 칸 사이를 벌리려면 낱말 앞에 gap을 주고, trailing은 줄 끝 공백 글자 여부입니다. */
    private fun line(y: Float, x0: Float, vararg words: Pair<String, Float>, size: Float = 10f, trailing: Boolean = false): PdfLine {
        var x = x0
        val built = words.map { (text, gap) ->
            x += gap
            PdfWord(text, x, x + text.length * 7f, y, size).also { x = it.x1 + 5f }
        }
        return PdfLine(built.dropLast(1) + built.last().copy(trailingSpace = trailing))
    }

    private fun words(text: String) = text.split(' ').mapIndexed { index, word -> word to if (index == 0) 0f else 0f }.toTypedArray()
    private fun page(vararg lines: PdfLine) = PdfPage(lines.toList(), 600f, 800f)

    @Test
    fun joinsScreenWrappedLinesOnlyWhenTheLineReachedTheColumnEdge() {
        val text = helper.pdfPages(listOf(page(
            line(100f, 50f, *words("□ 지원대상 : 공고일 현재 본사 또는 주사업장이 서울특별시에 소재한 중소기업으로서 수출 실적이 있는 기업")),
            line(114f, 60f, *words("중 최근 3년 이내 동일 사업에 참여하지 않은 기업")),
            line(128f, 50f, *words("□ 신청기간 : 2026. 10. 1.(수) ~ 10. 31.(금) 온라인 접수만 가능합니다.")),
            line(142f, 60f, *words("※ 마감 시간 이후 접수 불가")),
        ))).single()
        assertEquals(
            listOf(
                "□ 지원대상 : 공고일 현재 본사 또는 주사업장이 서울특별시에 소재한 중소기업으로서 수출 실적이 있는 기업 중 최근 3년 이내 동일 사업에 참여하지 않은 기업",
                "□ 신청기간 : 2026. 10. 1.(수) ~ 10. 31.(금) 온라인 접수만 가능합니다.",
                "※ 마감 시간 이후 접수 불가",
            ),
            text.lines(),
        )
    }

    @Test
    fun keepsShortLinesLabelColumnsAndDistantLinesApart() {
        val text = helper.pdfPages(listOf(page(
            line(100f, 120f, *words("당사는 무역보험계약 및 관리 등을 위하여 상기 신청인 기본정보가 보험계약자에게 제공될 수 있으며 당사가")),
            line(110f, 20f, *words("보험계약의 체결")),
            line(114f, 120f, *words("공사가 정한 적격기준에 부합하지 않는 경우 보험관계 성립이 되지 않을 수 있음에 동의합니다.")),
            line(128f, 120f, *words("짧은 줄")),
            line(142f, 120f, *words("다음 문단은 줄 간격이 넓어서 앞줄과 잇지 않습니다 그래서 다음 문단은 줄 간격이 넓어서 앞줄과는 별도")),
            line(190f, 120f, *words("잇지 않습니다")),
        ))).single().lines()
        assertTrue("보험계약의 체결" in text)
        assertTrue(text.none { it.contains("보험계약자에게 제공될 수 있으며 당사가 보험계약의") })
        assertTrue("짧은 줄" in text)
        assertTrue("잇지 않습니다" in text)
    }

    @Test
    fun splitsWideGapsIntoTableCellsAndMergesSymbolNumberAndColonCells() {
        val text = helper.pdfPages(listOf(page(
            line(100f, 50f, "연번" to 0f, "제출서류" to 40f, "비고" to 120f),
            line(114f, 50f, "1" to 0f, "사업자등록증" to 40f, "중복" to 0f, "수혜" to 0f, "확인" to 0f, "필수" to 100f),
            line(128f, 50f, "2" to 0f, "지원" to 40f, "내용" to 0f),
            line(142f, 50f, "□" to 0f, "사업목적" to 40f),
            line(156f, 50f, "신청기간" to 0f, ":" to 40f, "상시" to 0f),
        ))).single().lines()
        assertEquals(listOf("연번 | 제출서류 | 비고", "1 | 사업자등록증 중복 수혜 확인 | 필수", "2. 지원 내용", "□ 사업목적", "신청기간 : 상시"), text)
    }

    @Test
    fun dropsPageNumbersAndKeepsARepeatedEdgeLineOnlyWhereItFirstAppears() {
        fun numbered(page: Int, body: String) = PdfPage(listOf(
            line(30f, 50f, *words("2026년 수출 지원사업 공고")),
            line(300f, 50f, *words(body)),
            line(310f, 50f, *words("2026년 수출 지원사업 공고")),
            line(780f, 290f, *words("- $page -")),
        ), 600f, 800f)
        val pages = helper.pdfPages(listOf(numbered(1, "첫 쪽 본문"), numbered(2, "둘째 쪽 본문"), numbered(3, "셋째 쪽 본문")))
        assertEquals(listOf("2026년 수출 지원사업 공고\n첫 쪽 본문\n2026년 수출 지원사업 공고", "둘째 쪽 본문\n2026년 수출 지원사업 공고", "셋째 쪽 본문\n2026년 수출 지원사업 공고"), pages)
        val twoPages = helper.pdfPages(listOf(numbered(1, "첫 쪽 본문"), numbered(2, "둘째 쪽 본문")))
        assertTrue(twoPages.all { it.startsWith("2026년 수출 지원사업 공고\n") && !it.contains("- ") })
        // 두 쪽을 한 장에 모아 찍은 PDF의 "- 9 -   - 10 -"도 쪽 번호입니다.
        val spread = helper.pdfPages(listOf(page(line(300f, 50f, *words("본문")), line(780f, 100f, "-" to 0f, "9" to 0f, "-" to 0f, "-" to 200f, "10" to 0f, "-" to 0f))))
        assertEquals(listOf("본문"), spread)
    }

    @Test
    fun joinsHangingIndentsAndUsesTheTrailingSpaceSignalForSpacing() {
        val first = line(100f, 70f, *words("◦ 신청대상: 도내 소재(본사 또는 공장) 중소기업으로 2026년 1~12월 중 해외 인증을 획득"), trailing = true)
        val lines = listOf(
            first,
            line(116f, first.words[2].x0, *words("완료한 기업(신청일 기준 획득 완료)이며 초과 금액은 수")),
            line(132f, first.words[2].x0, *words("혜기업이 부담")),
            line(148f, 70f, *words("‐ 선택항목 : 신청인 주소, 이메일, 연락처와 담당자 정보를 함께 적는 경우 우선 확인합니다 그리고"), trailing = true),
            line(164f, 80f, *words("제49조의2에 따라 근로복지공단으로부터 개인정보를 제공받습니다.")),
        )
        val text = helper.pdfPages(listOf(PdfPage(listOf(lines[0], lines[1].copy(words = lines[1].words.dropLast(1) + lines[1].words.last().copy(x1 = first.x1)), lines[2], lines[3], lines[4]), 600f, 800f))).single().lines()
        assertEquals(
            listOf(
                "◦ 신청대상: 도내 소재(본사 또는 공장) 중소기업으로 2026년 1~12월 중 해외 인증을 획득 완료한 기업(신청일 기준 획득 완료)이며 초과 금액은 수혜기업이 부담",
                "‐ 선택항목 : 신청인 주소, 이메일, 연락처와 담당자 정보를 함께 적는 경우 우선 확인합니다 그리고 제49조의2에 따라 근로복지공단으로부터 개인정보를 제공받습니다.",
            ),
            text,
        )
        // 글자·숫자가 아닌 기호 하나 뒤 공백("‐ ")은 새 글머리라서, 앞줄이 끝까지 차도 잇지 않습니다.
        val bullets = helper.pdfPages(listOf(page(
            line(100f, 70f, *words("‐ 필수항목 : 성명, 생년월일, 사업자등록번호, 상호, 사업장 주소, 계좌번호, 전화번호, 근로자 유무")),
            line(116f, 70f, *words("‐ 선택항목 : 신청인 주소, 이메일")),
        ))).single().lines()
        assertEquals(2, bullets.size)
    }

    @Test
    fun gluesOnlyClearlyBrokenWords() {
        assertEquals("", helper.glue("동일 사업에 참여한 기업은 신청할 수 없습", "니다."))
        assertEquals("", helper.glue("지원 대상 기", "업은 제외"))
        assertEquals(" ", helper.glue("신청서 및", "참여 확약서"))
        assertEquals(" ", helper.glue("중소기", "업은 제외"))
        assertEquals(" ", helper.glue("신청 기", "2026년"))
        assertEquals("", helper.glue("초과 금액은 수", "혜기업이 부담", trailingSpace = false))
        assertEquals(" ", helper.glue("본 사업 추진을", "위한 4년의 임대차", trailingSpace = true))
        assertEquals(" ", helper.glue("신청서 및", "참여 확약서", trailingSpace = true))
        // 줄 끝 공백 글자가 빠졌어도 홀로 쓰는 낱말·흔한 토씨로 끝나면 띄웁니다. 애매한 한 글자("수")는 신호를 따릅니다.
        assertEquals(" ", helper.glue("귀책사유에 따라 대상기관 및", "대상자에 대하여", trailingSpace = false))
        assertEquals(" ", helper.glue("정부출연금의 전부", "또는 일부를 환수", trailingSpace = false))
        assertEquals(" ", helper.glue("개인정보를 제3자에게", "제공하는 것에 동의", trailingSpace = false))
        assertEquals("", helper.glue("같은 법 제2조제8", "호에 따른 복합유통게임제공업", trailingSpace = false))
        assertEquals("", helper.glue("영업으", "로 대통령령으로 정하는 것", trailingSpace = false))
    }

    @Test
    fun mergesCellsWithoutTouchingOrdinaryRows() {
        assertEquals(listOf("구분 | 내용"), listOf(helper.mergeCells(listOf("구분", "내용")).joinToString(" | ")))
        assertEquals(listOf("Ⅱ. 신청 자격"), helper.mergeCells(listOf("Ⅱ", "신청 자격")))
        assertEquals(listOf("3", "2026. 10. 31.까지 제출한 신청서에 한하여 검토"), helper.mergeCells(listOf("3", "2026. 10. 31.까지 제출한 신청서에 한하여 검토")))
        assertEquals(listOf("• 동일 과제 중복 지원 불가"), helper.mergeCells(listOf("•", "동일 과제 중복 지원 불가")))
        assertEquals(listOf("업태", "주 요 생 산 품"), helper.mergeCells(listOf("업", "태", "주 요 생 산 품")))
        assertEquals(listOf("연도", "추정"), helper.mergeCells(listOf("연도", "추", "정")))
        assertEquals(listOf("붙임 소상공인 정책자금 융자제외 대상 업종"), helper.mergeCells(listOf("붙임", "소상공인 정책자금 융자제외 대상 업종")))
        assertEquals(listOf("[별지 제2호] 참여 확약서"), helper.mergeCells(listOf("[별지 제2호]", "참여 확약서")))
        assertEquals(listOf("20", "등 지원의 필요성"), helper.mergeCells(listOf("20", "등 지원의 필요성")))
        assertEquals(listOf("6", "최근3년 전시 참가 확인자료"), helper.mergeCells(listOf("6", "최근3년 전시 참가 확인자료")))
    }

    @Test
    fun readsHwpxTablesRowByRowAndKeepsBoxesNestedTablesTextBoxesAndFootnotes() {
        val xml = """
            <hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="$HP">
              <hp:p><hp:run><hp:t>1. 신청 자격</hp:t></hp:run></hp:p>
              <hp:p><hp:run><hp:t>아래 표의 기업</hp:t><hp:tbl>
                <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>구분</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>내용</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
                <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>제외 대상</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList>
                  <hp:p><hp:run><hp:t>동일 과제로 타 사업 수혜 기업</hp:t></hp:run></hp:p>
                  <hp:p><hp:run><hp:t>세부 기준</hp:t><hp:tbl>
                    <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>연도</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>2026</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
                  </hp:tbl></hp:run></hp:p>
                </hp:subList></hp:tc></hp:tr>
                <hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>설명</hp:t></hp:run></hp:p></hp:subList></hp:tc><hp:tc><hp:subList><hp:p><hp:run><hp:t>${"긴 설명 ".repeat(60).trim()}</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>
              </hp:tbl></hp:run></hp:p>
              <hp:p><hp:run><hp:tbl><hp:caption><hp:subList><hp:p><hp:run><hp:t>※ 표 제목의 신청 기간 안내</hp:t></hp:run></hp:p></hp:subList></hp:caption><hp:tr><hp:tc><hp:subList>
                <hp:p><hp:run><hp:t>※ 유의사항</hp:t></hp:run></hp:p>
                <hp:p><hp:run><hp:t>중복 지원 시 선정을 취소합니다.</hp:t></hp:run></hp:p>
              </hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
              <hp:p><hp:run><hp:t>본문 끝</hp:t><hp:rect><hp:drawText><hp:subList><hp:p><hp:run><hp:t>글상자 안내</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:rect>
                <hp:ctrl><hp:footNote><hp:subList><hp:p><hp:run><hp:t>각주 내용</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl></hp:run></hp:p>
            </hs:sec>
        """.trimIndent()
        val root = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
            .parse(ByteArrayInputStream(xml.toByteArray())).documentElement
        val lines = helper.hwpxLines(root)
        assertEquals(
            listOf(
                "1. 신청 자격", "아래 표의 기업", "구분 | 내용", "제외 대상 | 동일 과제로 타 사업 수혜 기업 세부 기준", "연도 | 2026",
                "설명", "긴 설명 ".repeat(60).trim(), "※ 표 제목의 신청 기간 안내", "※ 유의사항", "중복 지원 시 선정을 취소합니다.", "본문 끝", "글상자 안내", "각주 내용",
            ),
            lines.map { it.text },
        )
        assertEquals(listOf(1, 2, 3, 5), lines.take(4).map { it.paragraph })
        assertFalse(lines.any { it.paragraph == 0 })
    }

    private companion object { const val HP = "http://www.hancom.co.kr/hwpml/2011/paragraph" }
}
