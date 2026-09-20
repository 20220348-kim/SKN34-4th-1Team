package ai.govbiz.core._common.test

import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.data.redis.core.StringRedisTemplate

@TestConfiguration(proxyBeanMethods = false)
class RedisTestContainerConfig {
    @Bean(destroyMethod = "close")
    fun documentRedisConnection() = RedisTestConnection()

    @Bean
    fun stringRedisTemplate(connection: RedisTestConnection): StringRedisTemplate = connection.redis
}
