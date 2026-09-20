package ai.govbiz.core.account.client.oauth

import ai.govbiz.core.account.domain.OAuthProfile
import ai.govbiz.core.account.domain.OAuthProvider
import java.net.URI

/**
 * 공급자별 OpenID Connect 인가 코드 흐름의 외부 경계입니다. 구현체는 Google·카카오 두 개이며,
 * Service는 공급자를 구분하지 않고 인가 주소를 만들고 인가 코드를 사용자로 바꿉니다.
 */
interface OAuthProviderClient {

    val provider: OAuthProvider

    /** 클라이언트 ID와 시크릿이 모두 설정됐는지입니다. 꺼진 공급자는 로그인 버튼도 보이지 않습니다. */
    fun isConfigured(): Boolean

    /** 공급자 로그인 화면 주소입니다. PKCE를 지원하는 공급자만 [codeVerifier]로 S256 challenge를 붙입니다. */
    fun authorizationUri(state: String, nonce: String, codeVerifier: String): URI

    /** 인가 코드를 토큰으로 바꾸고 ID 토큰의 발급자·대상·만료·nonce를 확인해 사용자를 돌려줍니다. */
    fun exchange(code: String, codeVerifier: String, nonce: String): OAuthProfile
}
