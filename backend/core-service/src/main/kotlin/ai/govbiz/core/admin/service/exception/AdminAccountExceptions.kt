package ai.govbiz.core.admin.service.exception

/** 로그인했지만 관리자가 아닌 계정이 관리자 API를 불렀습니다. 권한 변경 중 처리자의 권한이 먼저 내려간 경우도 같습니다. */
class AdminAccessDeniedException : RuntimeException()

/** 없거나 삭제된 계정입니다. */
class AdminAccountNotFoundException : RuntimeException()

/** 관리자가 자기 계정을 정지하거나 강제 로그아웃하거나 자기 권한을 바꾸려 했습니다. */
class AdminSelfActionException : RuntimeException()

/** 다른 관리자 계정은 정지·강제 로그아웃할 수 없습니다. 권한을 먼저 내려야 합니다. */
class AdminTargetProtectedException : RuntimeException()

/** 이미 그 상태인 계정에 같은 조치를 하거나(정지·정지 해제·같은 역할), 정지된 계정을 관리자로 올리려 했습니다. */
class AdminAccountStateConflictException : RuntimeException()

/** 권한을 내리면 정지되지 않은 관리자가 한 명도 남지 않습니다. */
class AdminLastActiveAdminException : RuntimeException()

/** 관리자 접속기록을 남기지 못했습니다. 기록되지 않은 개인정보 조회·조치를 허용하지 않으므로 요청 전체를 실패시킵니다. */
class AdminAccessLogUnavailableException(cause: Throwable) :
    RuntimeException("The admin access log could not be written.", cause)
