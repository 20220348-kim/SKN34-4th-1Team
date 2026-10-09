package ai.govbiz.core.supportprogram.client.kstartup.helper

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * K-Startup 공식 상세 페이지 주소 검증과 진행·마감 상태 페이지 이동 안내(`fullUrl`) 해석입니다.
 * 첨부 수집과 원문 근거 수집 Client가 같은 상세 페이지 규칙을 쓰도록 모읍니다.
 */
internal object KStartupDetailPageHelper {
    val HOSTS = setOf("k-startup.go.kr", "www.k-startup.go.kr")
    const val ONGOING_PATH = "/web/contents/bizpbanc-ongoing.do"
    const val DEADLINE_PATH = "/web/contents/bizpbanc-deadline.do"
    val DETAIL_PATHS = setOf(ONGOING_PATH, DEADLINE_PATH)
    private val ALLOWED_PARAMETERS = setOf("pbancSn", "schM")
    private val FULL_URL = Regex("var\\s+fullUrl\\s*=\\s*['\"]([^'\"]+)['\"]\\s*;")

    /**
     * 공식 HTTPS 상세 주소이고 요청한 공고 번호 하나만 가리키는지 확인합니다.
     * 질의 문자열을 디코딩할 수 없으면 [IllegalArgumentException]을 그대로 전달합니다.
     */
    fun isDetailUri(uri: URI, sourceProgramId: String): Boolean {
        if (uri.scheme != "https" || uri.host !in HOSTS || uri.userInfo != null || uri.fragment != null ||
            uri.port !in listOf(-1, 443) || uri.path !in DETAIL_PATHS) return false
        val parameters = parameters(uri)
        return parameters.keys.all { it in ALLOWED_PARAMETERS } &&
            parameters["pbancSn"] == listOf(sourceProgramId) &&
            (parameters["schM"] ?: listOf("view")) == listOf("view")
    }

    /**
     * 마감된 공고의 진행 중 상세 페이지는 본문 없이 스크립트 변수 `fullUrl`로 마감 페이지 주소만 알려 줍니다.
     * 그 주소(HTML 엔티티 `&amp;`는 `&`로 되돌림)를 돌려주고, 없으면 null입니다. 주소 검증은 호출부가 합니다.
     */
    fun fullUrl(html: String): String? = FULL_URL.find(html)?.groupValues?.get(1)?.replace("&amp;", "&")

    private fun parameters(uri: URI): Map<String, List<String>> = uri.rawQuery.orEmpty().split('&')
        .filter(String::isNotBlank).groupBy(
            { URLDecoder.decode(it.substringBefore('='), StandardCharsets.UTF_8) },
            { URLDecoder.decode(it.substringAfter('=', ""), StandardCharsets.UTF_8) },
        )
}
