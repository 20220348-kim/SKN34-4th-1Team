package ai.govbiz.core.admin.service.exception

/** 로그인했지만 관리자가 아닌 계정이 관리자 API를 불렀습니다. */
class AdminAccessDeniedException : RuntimeException()

/** 없거나 삭제된 계정입니다. */
class AdminAccountNotFoundException : RuntimeException()

/** 관리자가 자기 계정을 정지하거나 강제 로그아웃하려 했습니다. */
class AdminSelfActionException : RuntimeException()

/** 다른 관리자 계정은 정지·강제 로그아웃할 수 없습니다. 권한을 먼저 내려야 합니다. */
class AdminTargetProtectedException : RuntimeException()

/** 이미 정지된 계정을 정지하거나, 정지되지 않은 계정의 정지를 풀려 했습니다. */
class AdminAccountStateConflictException : RuntimeException()
