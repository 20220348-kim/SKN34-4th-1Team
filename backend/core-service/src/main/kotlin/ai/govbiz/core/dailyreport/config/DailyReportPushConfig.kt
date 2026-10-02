package ai.govbiz.core.dailyreport.config

import ai.govbiz.core._common.helper.buildRestClient
import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler
import org.springframework.web.client.RestClient

@ConfigurationProperties(prefix = "app.daily-report.push")
class DailyReportPushProperties(val enabled: Boolean = false, val accessToken: String = "")

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(DailyReportPushProperties::class)
class DailyReportPushConfig {
    @Bean
    fun dailyReportPushRestClient(builder: RestClient.Builder, properties: DailyReportPushProperties): RestClient {
        if (properties.accessToken.isNotBlank()) builder.defaultHeader("Authorization", "Bearer ${properties.accessToken}")
        return buildRestClient(builder, URI("https://exp.host"), Duration.ofSeconds(3), Duration.ofSeconds(10))
    }

    @Bean
    fun dailyReportPushTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("daily-report-push-")
    }
}
