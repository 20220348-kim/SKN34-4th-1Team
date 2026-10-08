package ai.govbiz.core.planusage.repository.exception

/** 사용량 저장소(MySQL·Redis)를 읽거나 쓰지 못했습니다. 한도를 확인할 수 없으므로 유료 기능을 실행하지 않습니다. */
class PlanUsageStoreException(cause: Throwable? = null) :
    RuntimeException("The plan usage store is unavailable.", cause)
