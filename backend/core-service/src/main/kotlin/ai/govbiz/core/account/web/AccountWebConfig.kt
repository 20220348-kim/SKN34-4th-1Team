package ai.govbiz.core.account.web

import ai.govbiz.core.account.service.AccountSessionService
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/**
 * 로그인이 필요한 Controller가 [ai.govbiz.core.account.domain.Account] 파라미터를 받을 수 있게 하고,
 * 세션 쿠키가 붙은 상태 변경 요청의 Origin을 검사합니다.
 *
 * 세션 Service는 실제 요청을 처리할 때 조회합니다. 웹 계층만 띄우는 Controller 테스트에서도 이 설정이
 * 함께 로드되므로 생성 시점에 Service·쿠키 helper 빈을 요구하지 않습니다.
 */
@Configuration(proxyBeanMethods = false)
class AccountWebConfig(
    private val sessionServiceProvider: ObjectProvider<AccountSessionService>,
    @param:Value("\${app.cors.allowed-origin}") private val allowedOrigin: String,
) : WebMvcConfigurer {

    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers.add(AuthenticatedAccountArgumentResolver { sessionServiceProvider.getObject() })
    }

    override fun addInterceptors(registry: InterceptorRegistry) {
        registry.addInterceptor(SessionOriginInterceptor(allowedOrigin.split(',')))
            .addPathPatterns("/api/**")
    }
}
