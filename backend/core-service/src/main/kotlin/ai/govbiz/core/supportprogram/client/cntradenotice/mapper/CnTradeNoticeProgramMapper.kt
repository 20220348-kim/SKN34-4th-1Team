package ai.govbiz.core.supportprogram.client.cntradenotice.mapper

import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticeProgramPayload
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import java.time.format.DateTimeParseException
import org.jsoup.Jsoup

/** 지역·기간 메타데이터가 없는 공지 본문을 자격 조건 추정 없이 보존합니다. */
internal object CnTradeNoticeProgramMapper {
    // 공식 웹 상세 idx는 암호화된 값이며 API lbbNo와의 변환 계약이 없습니다. 상세 주소를 추측하지 않습니다.
    const val OFFICIAL_NOTICE_LIST_URL = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
    private const val LIST_NOTICE = "개별 원문은 공식 공지 목록에서 공고 제목으로 찾아 주세요."

    fun mapValidated(payloads: List<CnTradeNoticeProgramPayload>): List<CatalogSupportProgram> {
        val identities = HashSet<String>()
        return java.util.List.copyOf(payloads.map { payload ->
            val id = payload.id?.takeIf { NOTICE_ID.matches(it) }
                ?: invalid("CNTRADE_NOTICE API returned an invalid lbbNo")
            if (!identities.add(id)) invalid("CNTRADE_NOTICE API returned duplicate lbbNo values")
            val title = plainText(payload.title).takeIf(String::isNotBlank)
                ?: invalid("CNTRADE_NOTICE API returned a notice without a title")
            val organization = plainText(payload.organization).ifBlank { "정보 없음" }
            val originalText = plainText(payload.contentHtml).ifBlank { "정보 없음" }
            val summary = "$originalText\n\n$LIST_NOTICE"
            requireCharacterLimit(title, 500, "title")
            requireCharacterLimit(organization, 255, "organization")
            requireTextLimit(summary, "summary")
            requireTextLimit(originalText, "target description")
            CatalogSupportProgram(
                program = SupportProgram(
                    id = id, sourceCode = "CNTRADE_NOTICE", title = title, organization = organization,
                    summary = summary, categories = emptyList(), regions = emptyList(),
                    targetDescription = originalText,
                    applicationPeriod = "정보 없음", applicationStartDate = null, applicationEndDate = null,
                    status = SupportProgramStatus.UNKNOWN, sourceName = "충청남도 온라인수출지원시스템",
                    sourceUrl = OFFICIAL_NOTICE_LIST_URL, matchedReasons = emptyList(),
                ),
                // 게시일은 정렬에만 사용합니다. 타지역 재게시·시스템 공지도 있어 접수일/충남 소재를 추정하지 않습니다.
                sortTimestamp = registrationDate(payload.registeredDate),
            )
        })
    }

    private fun registrationDate(value: String?): String {
        if (value == null || !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(value)) return ""
        return try { LocalDate.parse(value).toString() } catch (_: DateTimeParseException) { "" }
    }

    private fun plainText(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val document = Jsoup.parseBodyFragment(value)
        document.select("script,style").remove()
        return document.body().text().trim()
    }

    private fun requireCharacterLimit(value: String, limit: Int, field: String) {
        if (value.codePointCount(0, value.length) > limit) invalid("CNTRADE_NOTICE API returned an oversized $field")
    }

    private fun requireTextLimit(value: String, field: String) {
        if (value.toByteArray(StandardCharsets.UTF_8).size > 65_535) invalid("CNTRADE_NOTICE API returned an oversized $field")
    }

    private fun invalid(message: String): Nothing = throw CnTradeNoticeClientException.invalidResponse(message)
    private val NOTICE_ID = Regex("[1-9][0-9]{0,254}")
}
