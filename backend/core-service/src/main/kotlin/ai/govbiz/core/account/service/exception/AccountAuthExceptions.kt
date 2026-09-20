package ai.govbiz.core.account.service.exception

/** 이메일 또는 비밀번호가 맞지 않을 때 발생합니다. 두 경우를 구분하지 않습니다. */
class InvalidCredentialsException : RuntimeException()

/** 가입하려는 이메일이 이미 등록되어 있을 때 발생합니다. 탈퇴한 계정은 이메일이 익명화돼 다시 가입할 수 있습니다. */
class EmailAlreadyRegisteredException : RuntimeException()

/** 세션 쿠키가 없거나 만료·삭제됐을 때 발생합니다. */
class AuthenticationRequiredException : RuntimeException()

/** 관리자가 정지한 계정으로 로그인하거나 세션을 쓰려 할 때 발생합니다. */
class AccountSuspendedException : RuntimeException()

/** 같은 계정 또는 같은 접속 주소의 로그인 시도가 한도를 넘었을 때 발생합니다. */
class LoginRateLimitedException(val retryAfterSeconds: Int) : RuntimeException() {
    init {
        require(retryAfterSeconds >= 1) { "retryAfterSeconds must be positive" }
    }
}

/** 세션 쿠키가 붙은 상태 변경 요청의 Origin이 허용 목록에 없을 때 발생합니다. */
class SessionOriginRejectedException : RuntimeException()

/** 기업을 아직 등록하지 않은 회원이 기업 조회·수정을 요청했을 때 발생합니다. */
class CompanyNotRegisteredException : RuntimeException()

/** 계정에 이미 기업이 등록되어 있을 때 발생합니다. */
class CompanyAlreadyRegisteredException : RuntimeException()

/** 등록되지 않은 사업자등록번호입니다. */
class BusinessNotFoundException : RuntimeException()

/** 휴업·폐업 사업자는 등록할 수 없습니다. [businessStatus]는 사업자 상태 원문입니다. */
class BusinessNotActiveException(val businessStatus: String) : RuntimeException()

/** 다른 계정이 이미 같은 사업자등록번호를 등록했을 때 발생합니다. */
class BusinessNumberAlreadyRegisteredException : RuntimeException()

/** 비밀번호 변경·계정 삭제에서 입력한 현재 비밀번호가 저장된 것과 다를 때 발생합니다. 세션은 유효하므로 401이 아닙니다. */
class CurrentPasswordMismatchException : RuntimeException()

/** 활성 관리자가 한 명뿐인데 그 관리자가 스스로 탈퇴하려 했습니다. 관리자 화면을 열 계정이 없어지므로 막습니다. */
class LastAdminDeletionException : RuntimeException()

/** 요청 검증은 통과했지만 시계가 필요한 규칙(설립연도는 올해까지)에 걸린 기업 프로필 필드입니다. 400으로 필드명을 알립니다. */
class CompanyProfileInvalidException(val field: String) : RuntimeException("company profile field $field is invalid")

/** 비밀번호 재설정 토큰이 없거나 만료됐거나 이미 쓴 토큰일 때 발생합니다. 셋을 구분하지 않습니다. */
class PasswordResetTokenInvalidException : RuntimeException()

/** SMTP가 설정되지 않았거나 전송에 실패해 재설정 메일을 보낼 수 없을 때 발생합니다. */
class PasswordResetMailUnavailableException(cause: Throwable? = null) : RuntimeException(cause)

/** 회원가입 인증번호가 틀렸을 때 발생합니다. 시도 횟수는 서비스가 올립니다. */
class EmailCodeInvalidException : RuntimeException()

/** 보낸 인증번호가 없거나 만료됐거나 시도 횟수를 다 썼을 때 발생합니다. 새로 받아야 합니다. */
class EmailCodeExpiredException : RuntimeException()

/** 인증번호 재전송 대기 시간이나 발송 한도에 걸렸을 때 발생합니다. */
class EmailCodeRateLimitedException(val retryAfterSeconds: Int) : RuntimeException() {
    init {
        require(retryAfterSeconds > 0) { "retryAfterSeconds must be positive" }
    }
}

/** 가입 요청의 통행 토큰이 없거나 그 이메일로 인증을 마친 토큰이 아닐 때 발생합니다. */
class EmailVerificationRequiredException : RuntimeException()

/** SMTP가 설정되지 않았거나 전송에 실패해 인증번호 메일을 보낼 수 없을 때 발생합니다. */
class EmailVerificationMailUnavailableException(cause: Throwable? = null) : RuntimeException(cause)
