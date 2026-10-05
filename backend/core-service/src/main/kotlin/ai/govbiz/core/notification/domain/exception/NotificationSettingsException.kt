package ai.govbiz.core.notification.domain.exception

enum class NotificationSettingsErrorCode { EMAIL_CONFIRMATION_REQUIRED, EMAIL_DELIVERY_UNAVAILABLE, PUSH_DELIVERY_UNAVAILABLE }

/** 수신 주소나 발송 설정 원문을 공개하지 않는 안정적인 알림 설정 오류입니다. */
class NotificationSettingsException(val code: NotificationSettingsErrorCode) : RuntimeException(code.name)
