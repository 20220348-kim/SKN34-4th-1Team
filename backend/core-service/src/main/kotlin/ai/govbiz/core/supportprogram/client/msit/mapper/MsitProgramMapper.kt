package ai.govbiz.core.supportprogram.client.msit.mapper

import ai.govbiz.core.supportprogram.client.msit.dto.MsitProgramPayload
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import ai.govbiz.core.supportprogram.client.msit.helper.MsitDetailUrlHelper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import java.time.LocalDate
import java.time.format.DateTimeParseException
import org.jsoup.Jsoup

internal object MsitProgramMapper {
    fun mapValidated(payloads: List<MsitProgramPayload>): List<CatalogSupportProgram> {
        val identities = HashSet<String>()
        return java.util.List.copyOf(payloads.map { payload ->
            val id = MsitDetailUrlHelper.extractProgramId(payload.sourceUrl)
            if (!identities.add(id)) invalid("MSIT API returned duplicate announcement identities")
            val title = plainText(payload.title).takeIf(String::isNotBlank)
                ?: invalid("MSIT API returned an announcement without a title")
            val organization = plainText(payload.organization).ifBlank { "과학기술정보통신부" }
            val sourceUrl = payload.sourceUrl!!
            requireCharacterLimit(title, 500, "title")
            requireCharacterLimit(organization, 255, "organization")
            requireCharacterLimit(sourceUrl, 2048, "source URL")
            CatalogSupportProgram(
                program = SupportProgram(
                    id = id, sourceCode = "MSIT", title = title, organization = organization,
                    summary = "공식 API에 지원 대상·접수 기간·본문이 제공되지 않습니다. 모집 여부와 신청 자격은 원문을 확인해 주세요.",
                    categories = emptyList(), regions = emptyList(), targetDescription = "정보 없음",
                    applicationPeriod = "정보 없음", applicationStartDate = null, applicationEndDate = null,
                    status = SupportProgramStatus.UNKNOWN, sourceName = "과학기술정보통신부", sourceUrl = sourceUrl,
                    matchedReasons = emptyList(),
                ),
                // 게시일을 접수 시작일이나 신청 자격으로 오인하지 않고 정렬에만 사용합니다.
                sortTimestamp = publishedDate(payload.publishedAt),
            )
        })
    }

    private fun publishedDate(value: String?): String {
        val text = value?.trim().orEmpty()
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(text)) return ""
        return try { LocalDate.parse(text).toString() } catch (_: DateTimeParseException) { "" }
    }

    private fun plainText(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val document = Jsoup.parseBodyFragment(value)
        document.select("script,style").remove()
        return document.body().text().trim()
    }

    private fun requireCharacterLimit(value: String, limit: Int, field: String) {
        if (value.codePointCount(0, value.length) > limit) invalid("MSIT API returned an oversized $field")
    }

    private fun invalid(message: String): Nothing = throw MsitClientException.invalidResponse(message)
}
