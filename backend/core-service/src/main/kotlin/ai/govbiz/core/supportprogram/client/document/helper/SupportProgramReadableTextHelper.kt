package ai.govbiz.core.supportprogram.client.document.helper

import java.text.Normalizer
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode
import org.springframework.web.util.HtmlUtils

/**
 * 제공처별 공식 상세 HTML Mapper가 근거 답변용 원문을 같은 규칙으로 만들도록 읽기 가능한 텍스트 추출과
 * 제목 비교용 정규화를 모읍니다. 결과 문자열은 원문 contentHash와 청크 재사용 키가 되므로 규칙을 바꾸면 안 됩니다.
 */
internal object SupportProgramReadableTextHelper {
    /** 근거로 쓰기에 너무 짧은 본문을 거르는 최소 글자 수입니다. */
    const val MIN_CONTENT_LENGTH = 80

    // 줄 단위 청킹은 빈 줄을 하나 더 넣을 수 있습니다. MySQL의 제목·URL 상한을 포함해도
    // 50 × 1,500자 청크 한도 안에 남도록 원문 본문은 보수적으로 제한합니다.
    const val MAX_CONTENT_LENGTH = 30_000

    private val WHITESPACE = Regex("[\\t \\x0B\\f\\r]+")
    private val EXCESSIVE_BLANK_LINES = Regex("\\n{3,}")
    private val NORMALIZED_WHITESPACE = Regex("\\s+")
    private val ALLOWED_CONTROL_CODE_POINTS = setOf('\n'.code, '\r'.code, '\t'.code)
    private val UNICODE_OTHER_TYPES = setOf(
        Character.CONTROL.toInt(),
        Character.FORMAT.toInt(),
        Character.PRIVATE_USE.toInt(),
        Character.SURROGATE.toInt(),
        Character.UNASSIGNED.toInt(),
    )

    /** 원본 [contents]는 바꾸지 않고, 스크립트·입력 요소를 뺀 뒤 블록 경계를 줄바꿈으로 살린 본문을 만듭니다. */
    fun extractReadableText(contents: Element): String {
        val readable = contents.clone()
        readable.select("script, style, noscript, header, nav, footer, svg, iframe, button, input, select, textarea, [hidden]").remove()
        readable.select("p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, td, th, br, dt, dd, table, ul, ol")
            .forEach { block ->
                block.before(TextNode("\n"))
                block.after(TextNode("\n"))
            }
        return removeUnsupportedUnicodeOtherCharacters(readable.wholeText())
            .replace(' ', ' ')
            .let { WHITESPACE.replace(it, " ") }
            .lineSequence()
            .map(String::trim)
            .joinToString("\n")
            .let { EXCESSIVE_BLANK_LINES.replace(it, "\n\n") }
            .trim()
    }

    /** 공고명 비교와 원문 머리글에 쓰도록 NFKC·HTML 엔티티·제어 문자·공백을 정리합니다. */
    fun normalizeForComparison(value: String): String =
        NORMALIZED_WHITESPACE.replace(
            removeUnsupportedUnicodeOtherCharacters(
                HtmlUtils.htmlUnescape(Normalizer.normalize(value, Normalizer.Form.NFKC)),
            ),
            " ",
        ).trim()

    /** 줄바꿈·탭을 제외한 제어·서식·사용자 정의·대리·미할당 문자를 AI 경계 전에 지웁니다. */
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
}
