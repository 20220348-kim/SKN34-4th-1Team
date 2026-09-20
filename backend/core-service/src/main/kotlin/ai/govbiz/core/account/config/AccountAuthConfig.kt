package ai.govbiz.core.account.config

import ai.govbiz.core.account.service.AccountLoginAttemptGuard
import java.time.Clock
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder

/** 회원 비밀번호 해시, 로그인 시도 제한, 세션·개발 로그인·소셜 로그인 설정을 제공합니다. Spring Security filter chain은 사용하지 않습니다. */
@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(
    AccountSessionProperties::class,
    AccountDevLoginProperties::class,
    AccountPasswordResetProperties::class,
    AccountEmailVerificationProperties::class,
    AccountOAuthProperties::class,
    AccountMobileOAuthProperties::class,
)
class AccountAuthConfig {

    @Bean
    fun accountPasswordEncoder(): PasswordEncoder = BCryptPasswordEncoder()

    @Bean
    fun accountLoginAttemptGuard(@Qualifier("seoulClock") clock: Clock): AccountLoginAttemptGuard =
        AccountLoginAttemptGuard(clock)
}
