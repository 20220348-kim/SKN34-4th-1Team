package ai.govbiz.core.supportprogram.client.bizinfo.mapper

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.time.LocalDateTime
import java.text.Normalizer
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode
import org.springframework.web.util.HtmlUtils

/** 기업마당 상세 HTML에서 근거 답변용 읽기 가능한 원문을 추출합니다. */
internal object BizInfoSourceDocumentMapper {
    private val WHITESPACE = Regex("[\\t \\x0B\\f\\r]+")
    private val EXCESSIVE_BLANK_LINES = Regex("\\n{3,}")
    private val NORMALIZED_WHITESPACE = Regex("\\s+")

    fun fromHtml(
        program: SupportProgram,
        html: String,
        fetchedAt: LocalDateTime,
    ): SupportProgramSourceDocument {
        // 기업마당 HTML은 여러 문서가 이어져 body가 반복됩니다. 실제 공고 영역만 선택해
        // 메뉴·추천 공고·푸터가 현재 공고의 근거로 섞이지 않게 합니다.
        val detail = requireNotNull(Jsoup.parse(html).selectFirst(".support_project_detail")) {
            "BizInfo source document did not contain the official detail section"
        }
        val title = normalizeForComparison(detail.selectFirst(".title_area .title")?.text().orEmpty())
        require(title.isNotEmpty() && title == normalizeForComparison(program.title)) {
            "BizInfo source document did not match the requested program"
        }
        val contents = requireNotNull(detail.selectFirst(".view_cont")) {
            "BizInfo source document did not contain the official program content"
        }
        val text = extractReadableText(contents)
        require(text.length >= MIN_CONTENT_LENGTH) { "BizInfo source document did not contain enough readable text" }
        require(text.length <= MAX_CONTENT_LENGTH) { "BizInfo source document exceeded the safe text limit" }
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

    private fun extractReadableText(contents: Element): String {
        val readable = contents.clone()
        readable.select("script, style, noscript, header, nav, footer, svg, iframe, button, input, select, textarea, [hidden]").remove()
        readable.select("p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, td, th, br, dt, dd, table, ul, ol")
            .forEach { block ->
                block.before(TextNode("\n"))
                block.after(TextNode("\n"))
            }
        return removeUnsupportedUnicodeOtherCharacters(readable.wholeText())
            .replace('\u00a0', ' ')
            .let { WHITESPACE.replace(it, " ") }
            .lineSequence()
            .map(String::trim)
            .joinToString("\n")
            .let { EXCESSIVE_BLANK_LINES.replace(it, "\n\n") }
            .trim()
    }

    private fun normalizeForComparison(value: String): String =
        NORMALIZED_WHITESPACE.replace(
            removeUnsupportedUnicodeOtherCharacters(
                HtmlUtils.htmlUnescape(Normalizer.normalize(value, Normalizer.Form.NFKC)),
            ),
            " ",
        ).trim()

    private fun removeUnsupportedUnicodeOtherCharacters(value: String): String {
        val result = StringBuilder(value.length)
        var offset = 0
        while (offset < value.length) {
            val codePoint = value.codePointAt(offset)
            if (codePoint in ALLOWED_CONTROL_CODE_POINTS || Character.getType(codePoint) !in UNICODE_OTHER_TYPES) {
                result.appendCodePoint(codePoint)
            }
            offset += Character.charCount(codePoint)
        }
        return result.toString()
    }

    private const val MIN_CONTENT_LENGTH = 80
    // 줄 단위 청킹은 빈 줄을 하나 더 넣을 수 있습니다. MySQL의 제목·URL 상한을 포함해도
    // 50 × 1,500자 청크 한도 안에 남도록 원문 본문은 보수적으로 제한합니다.
    private const val MAX_CONTENT_LENGTH = 30_000
    private val ALLOWED_CONTROL_CODE_POINTS = setOf('\n'.code, '\r'.code, '\t'.code)
    private val UNICODE_OTHER_TYPES = setOf(
        Character.CONTROL.toInt(),
        Character.FORMAT.toInt(),
        Character.PRIVATE_USE.toInt(),
        Character.SURROGATE.toInt(),
        Character.UNASSIGNED.toInt(),
    )
}
