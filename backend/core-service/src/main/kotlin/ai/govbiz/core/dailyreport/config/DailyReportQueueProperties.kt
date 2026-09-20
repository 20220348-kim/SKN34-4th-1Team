package ai.govbiz.core.dailyreport.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("app.daily-report.queue")
data class DailyReportQueueProperties(val enabled: Boolean = false, val deliveryEnabled: Boolean = false)
