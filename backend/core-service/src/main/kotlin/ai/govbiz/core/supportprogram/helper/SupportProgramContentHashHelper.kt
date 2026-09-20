package ai.govbiz.core.supportprogram.helper

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

/** 지원사업 원문과 근거 청크의 UTF-8 SHA-256을 같은 방식으로 계산합니다. */
object SupportProgramContentHashHelper {
    fun sha256(value: String): String =
        HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)),
        )
}
