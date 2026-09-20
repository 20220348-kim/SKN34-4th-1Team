package ai.govbiz.core.account.service.exception

/** 등록되지 않은 복귀 URI 또는 잘못된 PKCE·state 입력입니다. 요청값은 오류에 포함하지 않습니다. */
class MobileOAuthRequestInvalidException : RuntimeException()

/** 앱 로그인 콜백·교환 코드가 없거나 만료·소비됐거나 PKCE가 다릅니다. */
class MobileOAuthExchangeInvalidException : RuntimeException()
