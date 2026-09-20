package ai.govbiz.core

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Import

@SpringBootTest(
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.ai-service.connect-timeout=10ms",
        "app.ai-service.read-timeout=10ms",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
    ],
)
@Import(MySqlTestContainerConfig::class)
class CoreApiApplicationTest {

    @Autowired
    private lateinit var applicationContext: ApplicationContext

    @Test
    fun contextLoadsWithoutRunningFastApi() {
    }

    @Test
    fun doesNotRegisterTheBizInfoSyncSchedulerInTests() {
        assertFalse(applicationContext.containsBean("bizInfoSupportProgramCatalogSyncScheduler"))
    }
}
