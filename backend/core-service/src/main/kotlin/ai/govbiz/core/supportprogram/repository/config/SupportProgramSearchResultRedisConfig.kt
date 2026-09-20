package ai.govbiz.core.supportprogram.repository.config

import io.lettuce.core.resource.Transports
import io.netty.channel.socket.SocketChannel
import io.netty.resolver.dns.DnsAddressResolverGroup
import io.netty.resolver.dns.DnsNameResolverBuilder
import org.springframework.boot.data.redis.autoconfigure.ClientResourcesBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class SupportProgramSearchResultRedisConfig {
    /** Redis 컨테이너 교체 시 과거 IP를 오래 붙잡지 않습니다. HTTP/JVM 전역 DNS 설정은 건드리지 않습니다. */
    @Bean(destroyMethod = "close")
    fun searchResultRedisAddressResolver(): DnsAddressResolverGroup = DnsAddressResolverGroup(
        DnsNameResolverBuilder()
            .datagramChannelType(Transports.datagramChannelClass())
            .socketChannelType(Transports.socketChannelClass().asSubclass(SocketChannel::class.java))
            .ttl(0, 5)
            .negativeTtl(0),
    )

    @Bean
    fun searchResultRedisResourcesCustomizer(resolver: DnsAddressResolverGroup): ClientResourcesBuilderCustomizer =
        ClientResourcesBuilderCustomizer { it.addressResolverGroup(resolver) }
}
