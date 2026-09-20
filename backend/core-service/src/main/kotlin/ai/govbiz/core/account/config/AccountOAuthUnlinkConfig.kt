package ai.govbiz.core.account.config

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(prefix = "app.account.oauth.unlink", name = ["enabled"], havingValue = "true")
class AccountOAuthUnlinkConfig {
    @Bean
    fun accountOAuthUnlinkTaskScheduler() = ThreadPoolTaskScheduler().apply {
        poolSize = 1
        setThreadNamePrefix("account-oauth-unlink-")
    }
}
