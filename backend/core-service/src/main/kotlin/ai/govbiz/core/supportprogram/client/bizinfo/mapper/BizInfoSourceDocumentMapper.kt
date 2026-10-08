package ai.govbiz.core.supportprogram.client.bizinfo.mapper

import ai.govbiz.core.supportprogram.client.document.helper.SupportProgramReadableTextHelper
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import java.time.LocalDateTime
import org.jsoup.Jsoup

/** 기업마당 상세 HTML에서 근거 답변용 읽기 가능한 원문을 추출합니다. */
internal object BizInfoSourceDocumentMapper {
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
        val title = SupportProgramReadableTextHelper.normalizeForComparison(detail.selectFirst(".title_area .title")?.text().orEmpty())
        require(title.isNotEmpty() && title == SupportProgramReadableTextHelper.normalizeForComparison(program.title)) {
            "BizInfo source document did not match the requested program"
        }
        val contents = requireNotNull(detail.selectFirst(".view_cont")) {
            "BizInfo source document did not contain the official program content"
        }
        val text = SupportProgramReadableTextHelper.extractReadableText(contents)
        require(text.length >= SupportProgramReadableTextHelper.MIN_CONTENT_LENGTH) {
            "BizInfo source document did not contain enough readable text"
        }
        require(text.length <= SupportProgramReadableTextHelper.MAX_CONTENT_LENGTH) {
            "BizInfo source document exceeded the safe text limit"
        }
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
}
