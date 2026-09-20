package ai.govbiz.core._common.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.config.annotation.CorsRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/** 브라우저 공개 API의 개발 환경 CORS 정책입니다. */
@Configuration(proxyBeanMethods = false)
class WebCorsConfig(
    @param:Value("\${app.cors.allowed-origin}") private val allowedOrigin: String,
) : WebMvcConfigurer {

    override fun addCorsMappings(registry: CorsRegistry) {
        registry.addMapping("/api/**")
            .allowedOrigins(allowedOrigin)
            .allowedMethods("GET", "POST", "PUT", "DELETE")
            .allowedHeaders("*")
            .exposedHeaders("Retry-After")
            // 세션 쿠키가 다른 origin의 개발 서버에서 온 요청에도 붙도록 허용합니다. origin이 고정돼 있어 안전합니다.
            .allowCredentials(true)
    }
}
