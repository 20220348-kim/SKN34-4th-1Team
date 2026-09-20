package ai.govbiz.core._common.test

import java.time.Duration
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.StringRedisTemplate
import org.testcontainers.containers.GenericContainer

/** JVM 종료 시 Testcontainers가 회수하는 전용 Redis. 각 사용처는 별도의 클라이언트를 닫습니다. */
class RedisTestConnection : AutoCloseable {
    private val factory = LettuceConnectionFactory(
        RedisStandaloneConfiguration(container.host, container.getMappedPort(6379)),
        LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(2)).build(),
    ).apply { afterPropertiesSet(); start() }
    val redis = StringRedisTemplate(factory)

    override fun close() { factory.destroy() }

    companion object {
        private val container: GenericContainer<*> by lazy {
            GenericContainer("redis:8.2.9-alpine").withExposedPorts(6379)
                .withCommand("redis-server", "--maxmemory", "128mb", "--maxmemory-policy", "noeviction")
                .apply { start() }
        }
    }
}
