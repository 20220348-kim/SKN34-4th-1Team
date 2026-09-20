package ai.govbiz.core.account.client.oauth.config

import ai.govbiz.core._common.helper.buildRestClient
import ai.govbiz.core.account.config.AccountOAuthProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.client.RestClient

@Configuration(proxyBeanMethods = false)
class OAuthClientConfig {

    /** 공급자마다 호스트가 달라 base URL 없이 공식 endpoint 절대 주소로 호출합니다. 리다이렉트는 따라가지 않습니다. */
    @Bean
    fun oauthRestClient(
        restClientBuilder: RestClient.Builder,
        properties: AccountOAuthProperties,
    ): RestClient = buildRestClient(
        restClientBuilder,
        null,
        properties.connectTimeout,
        properties.readTimeout,
    )
}
