package ai.govbiz.core.supportprogram.client.msit.helper

import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

/** 동일 게시판의 공식 상세 URL에서만 영속 식별자를 추출합니다. */
internal object MsitDetailUrlHelper {
    fun extractProgramId(value: String?): String {
        try {
            val uri = URI(value ?: "")
            val host = uri.host?.lowercase(Locale.ROOT)
            if (!uri.scheme.equals("https", ignoreCase = true) || uri.rawUserInfo != null ||
                uri.port !in listOf(-1, 443) || uri.rawFragment != null ||
                host !in setOf("msit.go.kr", "www.msit.go.kr") || uri.rawPath != "/bbs/view.do") {
                invalid()
            }
            val parameters = uri.rawQuery.orEmpty().split('&').map { parameter ->
                URLDecoder.decode(parameter.substringBefore('='), StandardCharsets.UTF_8) to
                    URLDecoder.decode(parameter.substringAfter('=', ""), StandardCharsets.UTF_8)
            }
            val boards = parameters.filter { it.first == "bbsSeqNo" }.map { it.second }
            val ids = parameters.filter { it.first == "nttSeqNo" }.map { it.second }
            if (boards != listOf("100") || ids.size != 1 || !PROGRAM_ID.matches(ids.single())) invalid()
            return ids.single()
        } catch (_: java.net.URISyntaxException) {
            invalid()
        } catch (_: IllegalArgumentException) {
            invalid()
        }
    }

    private fun invalid(): Nothing = throw MsitClientException.invalidResponse("MSIT API returned an unsafe or ambiguous official detail URL")
    private val PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
}
