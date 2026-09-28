package ai.govbiz.core.applicationpreparation.client.ai.exception

class ApplicationOnlineFormMcpException(val code: String, cause: Throwable? = null) :
    RuntimeException("공개 온라인 신청 양식을 읽지 못했습니다.", cause)
