package ai.govbiz.core.dailyreport.domain.exception

enum class DailyReportErrorCode {
    EMAIL_CONFIRMATION_REQUIRED, EMAIL_CONSENT_REQUIRED, EMAIL_DELIVERY_UNAVAILABLE,
    EMAIL_VERIFICATION_RATE_LIMITED, INVALID_EMAIL_TOKEN, REPORT_CAPACITY_EXCEEDED,
    REPORT_DAILY_BUDGET_EXCEEDED, SEARCH_NOT_READY,
}

/** 외부 오류의 내용이나 수신 주소를 공개하지 않는 안정적인 기능 오류다. */
class DailyReportException(val code: DailyReportErrorCode) : RuntimeException(code.name)
