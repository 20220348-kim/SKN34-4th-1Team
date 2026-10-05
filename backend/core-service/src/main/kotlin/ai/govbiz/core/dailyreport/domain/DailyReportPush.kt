package ai.govbiz.core.dailyreport.domain

import java.time.LocalDate

data class DailyReportPushDelivery(
    val id: Long, val reportId: Long, val deviceId: String, val expoToken: String,
    val reportDate: LocalDate, val ticketId: String?,
)
data class DailyReportPushOutcome(val status: String, val ticketId: String? = null, val errorCode: String? = null)

/** 지금 알림을 받을 수 있는 기기입니다. 앱 알림을 켰고 연결된 모바일 세션과 계정이 유효한 기기만 해당합니다. */
data class DailyReportPushDevice(val deviceId: String, val expoToken: String)
