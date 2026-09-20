package ai.govbiz.core.supportprogram.repository.config

import io.lettuce.core.resource.ClientResources
import io.netty.resolver.dns.DnsAddressResolverGroup
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.data.redis.autoconfigure.DataRedisAutoConfiguration
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class SupportProgramSearchResultRedisConfigTest {
    @Test
    fun springLettuceUsesTheLifecycleManagedShortLivedDnsResolver() {
        ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DataRedisAutoConfiguration::class.java))
            .withUserConfiguration(SupportProgramSearchResultRedisConfig::class.java)
            .run { context ->
                assertNull(context.startupFailure)
                assertSame(context.getBean(DnsAddressResolverGroup::class.java),
                    context.getBean(ClientResources::class.java).addressResolverGroup())
            }
    }
}
