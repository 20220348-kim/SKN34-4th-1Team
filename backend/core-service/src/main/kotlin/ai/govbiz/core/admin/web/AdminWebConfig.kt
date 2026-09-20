package ai.govbiz.core.admin.web

import ai.govbiz.core.account.service.AccountSessionService
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Configuration
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

/**
 * 관리자 Controller가 [AdminPrincipal] 파라미터를 받을 수 있게 합니다. 세션 쿠키가 붙은 상태 변경 요청의 Origin 검사는
 * `/api` 아래 전체에 걸린 account 설정이 그대로 맡습니다. 세션 Service는 실제 요청을 처리할 때 조회합니다.
 */
@Configuration(proxyBeanMethods = false)
class AdminWebConfig(
    private val sessionServiceProvider: ObjectProvider<AccountSessionService>,
) : WebMvcConfigurer {

    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers.add(AdminPrincipalArgumentResolver { sessionServiceProvider.getObject() })
    }
}
