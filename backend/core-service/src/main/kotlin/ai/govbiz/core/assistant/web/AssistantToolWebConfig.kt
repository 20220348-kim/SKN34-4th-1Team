package ai.govbiz.core.assistant.web

import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.service.AssistantToolTokenService
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/**
 * 도구 API 경로에만 문지기를 답니다. `/api/` 아래의 세션·Origin 검사와는 별개입니다.
 * `@WebMvcTest` 슬라이스처럼 설정·서비스 Bean이 없는 컨텍스트에서는 등록을 건너뜁니다(도구 API 자체가 없는 컨텍스트).
 */
@Configuration(proxyBeanMethods = false)
class AssistantToolWebConfig(
    private val properties: ObjectProvider<AssistantAgentProperties>,
    private val tokenService: ObjectProvider<AssistantToolTokenService>,
) : WebMvcConfigurer {
    override fun addInterceptors(registry: InterceptorRegistry) {
        val agentProperties = properties.ifAvailable ?: return
        val tokens = tokenService.ifAvailable ?: return
        registry.addInterceptor(AssistantToolAuthInterceptor(agentProperties, tokens))
            .addPathPatterns(AssistantToolAuthInterceptor.PATH_PATTERN)
    }
}
