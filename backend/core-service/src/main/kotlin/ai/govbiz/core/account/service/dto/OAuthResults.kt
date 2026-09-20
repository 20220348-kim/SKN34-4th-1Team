package ai.govbiz.core.account.service.dto

import ai.govbiz.core.account.helper.OAuthStateCookieHelper
import ai.govbiz.core.account.domain.Account
import java.net.URI

/** 소셜 로그인 시작 결과입니다. 브라우저를 [authorizationUri]로 보내고 [transaction]을 서명 쿠키로 들려 보냅니다. */
data class OAuthStartResult(
    val authorizationUri: URI,
    val transaction: OAuthStateCookieHelper.Transaction,
)

/** 공급자가 콜백으로 돌려준 값입니다. 성공이면 [code], 취소·실패면 [error]가 옵니다. 둘 다 [state]를 되돌려 줍니다. */
data class OAuthCallback(
    val code: String?,
    val state: String?,
    val error: String?,
)

/** 공급자 계정 확인 결과입니다. 앱은 세션 대신 짧은 교환 코드를 발급하므로 세션 발급과 분리합니다. */
sealed interface OAuthAccountCompletionResult {
    data class SignedIn(val account: Account, val returnPath: String) : OAuthAccountCompletionResult
    data class Failed(val failure: OAuthFailure, val returnPath: String) : OAuthAccountCompletionResult
}

/** 콜백 처리 결과입니다. 어느 쪽이든 로그인을 시작한 화면의 [returnPath]로 돌아갑니다. */
sealed interface OAuthCompletionResult {
    val returnPath: String

    data class SignedIn(
        val session: AccountSessionResult,
        override val returnPath: String,
    ) : OAuthCompletionResult

    data class Failed(
        val failure: OAuthFailure,
        override val returnPath: String,
    ) : OAuthCompletionResult
}

/** 프런트 로그인 화면이 안내를 고르는 실패 사유입니다. [code]가 `?oauthError=` 값입니다. */
enum class OAuthFailure(val code: String) {
    /** 공급자 화면에서 사용자가 취소했습니다. */
    CANCELLED("cancelled"),

    /** 로그인 상태 쿠키가 없거나 만료됐거나 state가 다릅니다. 다른 브라우저에서 시작했거나 위조된 콜백입니다. */
    EXPIRED("expired"),

    /** 설정되지 않았거나 모르는 공급자입니다. */
    UNAVAILABLE("unavailable"),

    /** 코드 교환·ID 토큰 검증 등 공급자 호출이 실패했습니다. */
    FAILED("failed"),

    /** 공급자가 인증한 이메일을 받지 못해 계정을 만들 수 없습니다. */
    EMAIL_REQUIRED("email-required"),

    /** 그 이메일로 이미 가입한 계정이 있어 자동으로 연결하지 않았습니다. */
    ACCOUNT_EXISTS("account-exists"),

    /** 이전 탈퇴의 외부 연결 해제 결과가 확정되지 않아 재가입을 차단했습니다. */
    UNLINK_PENDING("unlink-pending"),

    SUSPENDED("suspended"),
    RATE_LIMITED("rate-limited"),
}

/** 탈퇴 transaction 안에서 다른 기능의 로컬 개인정보를 정리한다. 외부 호출에는 사용하지 않는다. */
data class AccountDeletedEvent(val accountId: Long)
