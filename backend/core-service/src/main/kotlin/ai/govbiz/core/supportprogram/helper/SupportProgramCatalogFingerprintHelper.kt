package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

/** 현재 적격 공고의 검색 문서 ID·내용 해시를 기준으로 재현 가능한 카탈로그 지문을 만듭니다. */
object SupportProgramCatalogFingerprintHelper {

    fun calculate(programs: List<CatalogSupportProgram>): String =
        HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(
                programs
                    .asSequence()
                    .map(SupportProgramIndexDocumentMapper::fromCatalog)
                    .map { document -> "${document.id}:${document.contentHash}" }
                    .sorted()
                    .joinToString("\n")
                    .toByteArray(StandardCharsets.UTF_8),
            ),
        )
}
