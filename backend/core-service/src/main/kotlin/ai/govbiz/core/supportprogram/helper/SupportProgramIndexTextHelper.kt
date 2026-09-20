package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

/** 의미·키워드 색인이 같은 원문과 내용 해시를 사용하도록 검색 텍스트를 구성합니다. */
object SupportProgramIndexTextHelper {
    const val MAX_DOCUMENTS = 20_000
    private const val MAX_TEXT_CODE_POINTS = 12_000
    private val UNSUPPORTED_CONTROL_TEXT = Regex("[\\p{C}&&[^\\n\\r\\t]]")

    fun buildText(candidate: CatalogSupportProgram): String {
        val program = candidate.program
        val sourceLines = listOf(
            "제목: ${program.title}", "기관: ${program.organization}", "지원대상: ${program.targetDescription}",
            "분야: ${program.categories.joinToString(", ")}", "지역: ${program.regions.joinToString(", ")}",
            "신청기간: ${program.applicationPeriod}", "내용: ${program.summary}",
        )
        val startupLines = candidate.startupDetails?.takeIf { program.sourceCode == "KSTARTUP" }?.let { details ->
            buildList {
                if (details.startupStages.isNotEmpty()) add("창업 업력 분류: ${details.startupStages.joinToString(", ")}")
                if (details.applicantTypes.isNotEmpty()) add("대상 분류: ${details.applicantTypes.joinToString(", ")}")
                if (details.founderAges.isNotEmpty()) add("대표자 연령 분류: ${details.founderAges.joinToString(", ")}")
            }.takeIf { it.isNotEmpty() }?.let { listOf("검색용 분류 메타데이터 (신청 자격 근거 아님)") + it }
        }.orEmpty()
        val text = (sourceLines + startupLines).joinToString("\n").replace(UNSUPPORTED_CONTROL_TEXT, " ")
        return if (text.codePointCount(0, text.length) > MAX_TEXT_CODE_POINTS) {
            text.substring(0, text.offsetByCodePoints(0, MAX_TEXT_CODE_POINTS))
        } else text
    }

    fun calculateContentHash(text: String): String = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(StandardCharsets.UTF_8)),
    )
}
