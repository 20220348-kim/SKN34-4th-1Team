package ai.govbiz.core.supportprogram.client.kstartup.mapper

import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramReadableTextHelper
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.time.LocalDateTime
import org.jsoup.Jsoup

/** K-Startup 상세 HTML에서 근거 답변용 읽기 가능한 원문을 추출합니다. */
internal object KStartupSourceDocumentMapper {
    // 상세 영역 안에서도 사이트 공통 안내·첨부 목록·저작권 표시·목록 버튼과 화면에 보이지 않는 요소는
    // 공고 내용이 아니므로 근거에서 뺍니다. script·style·[hidden]은 공통 추출 규칙이 함께 지웁니다.
    private const val NON_CONTENT_SELECTOR =
        ".guide_wrap, .board_file, .copy_right_wrap, .lower_btn-wrap, [aria-hidden=true], [style~=(?i)display\\s*:\\s*none]"
    private val TITLE_IGNORED_CHARACTERS = Regex("[\\s\\p{P}\\p{S}]+")

    fun fromHtml(
        program: SupportProgram,
        html: String,
        fetchedAt: LocalDateTime,
    ): SupportProgramSourceDocument {
        // 메뉴·검색 폼·푸터가 근거로 섞이지 않도록 공고 상세 영역만 선택합니다.
        val details = requireNotNull(Jsoup.parse(html).selectFirst(".app_notice_details-wrap")) {
            "K-Startup source document did not contain the official detail section"
        }
        val title = SupportProgramReadableTextHelper.normalizeForComparison(details.selectFirst("#scrTitle h3")?.text().orEmpty())
        val pageTitleKey = titleKey(title)
        require(pageTitleKey.isNotEmpty() && pageTitleKey == titleKey(program.title)) {
            "K-Startup source document did not match the requested program"
        }
        val contents = details.clone().also { it.select(NON_CONTENT_SELECTOR).remove() }
        val text = SupportProgramReadableTextHelper.extractReadableText(contents)
        require(text.length >= SupportProgramReadableTextHelper.MIN_CONTENT_LENGTH) {
            "K-Startup source document did not contain enough readable text"
        }
        require(text.length <= SupportProgramReadableTextHelper.MAX_CONTENT_LENGTH) {
            "K-Startup source document exceeded the safe text limit"
        }
        // 마감 페이지로 넘어가 읽었어도 저장 URL은 공고의 공식 URL로 두어 원문 캐시 비교가 유지되게 합니다.
        val content = "공고명: $title\n공식 원문: ${program.sourceUrl}\n\n$text"

        return SupportProgramSourceDocument(
            sourceCode = program.sourceCode,
            sourceProgramId = program.id,
            sourceUrl = program.sourceUrl,
            content = content,
            contentHash = SupportProgramContentHashHelper.sha256(content),
            fetchedAt = fetchedAt,
        )
    }

    /** API 공고명과 상세 제목은 따옴표 종류(' 와 ")·공백·문장부호만 다를 수 있어 글자와 숫자만 비교합니다. */
    private fun titleKey(value: String): String =
        TITLE_IGNORED_CHARACTERS.replace(SupportProgramReadableTextHelper.normalizeForComparison(value), "")
}
