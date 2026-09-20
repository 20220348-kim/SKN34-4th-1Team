package ai.govbiz.core._common.test

import org.springframework.boot.test.context.TestConfiguration
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.context.annotation.Bean
import org.testcontainers.mysql.MySQLContainer

@TestConfiguration(proxyBeanMethods = false)
class MySqlTestContainerConfig {

    @Bean
    @ServiceConnection
    fun mysqlContainer(): MySQLContainer =
        MySQLContainer("mysql:8.4")
            .withDatabaseName("govbiz_test")
            .withUsername("govbiz")
            .withPassword("govbiz-test")
}
