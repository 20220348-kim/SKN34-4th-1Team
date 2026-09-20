package ai.govbiz.core.account.controller.dto

/** 로그인·회원가입 화면이 버튼을 그릴 공급자 목록입니다. 설정된 공급자만 담깁니다. */
data class OAuthProvidersResponse(
    val providers: List<OAuthProviderResponse>,
)

/** [provider]는 `kakao`·`google`이고, [startUrl]은 콜백과 같은 호스트의 로그인 시작 주소입니다. */
data class OAuthProviderResponse(
    val provider: String,
    val startUrl: String,
)
