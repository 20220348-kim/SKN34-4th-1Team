package ai.govbiz.core.assistant.service.exception

/** 공유 비밀이나 계정 묶음 토큰이 없거나 틀린 도구 요청입니다. 어떤 값이 틀렸는지는 알리지 않습니다. */
class AssistantToolUnauthorizedException : RuntimeException("assistant tool request is not authorized")

/** 공유 비밀이 설정되지 않아 도구 API가 닫혀 있습니다. */
class AssistantToolsDisabledException : RuntimeException("assistant tools are disabled")
