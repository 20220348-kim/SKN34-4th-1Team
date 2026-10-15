package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

/** 의미 검색 표현 변경과 무관하게 기존 전체 본문 기준의 카탈로그 지문을 유지합니다. */
object SupportProgramCatalogFingerprintHelper {

    fun calculate(programs: List<CatalogSupportProgram>): String =
        HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(
                programs
                    .asSequence()
                    .map { candidate ->
                        val hash = SupportProgramIndexTextHelper.calculateContentHash(SupportProgramIndexTextHelper.buildText(candidate))
                        "${candidate.program.sourceQualifiedId}:$hash"
                    }
                    .sorted()
                    .joinToString("\n")
                    .toByteArray(StandardCharsets.UTF_8),
            ),
        )
}
