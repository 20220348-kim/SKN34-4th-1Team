package ai.govbiz.core.applicationpreparation.config

import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepository
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentGenerationJobService
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentGenerationJobWorker
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.boot.convert.ApplicationConversionService
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class ApplicationDocumentGenerationConfigTest {
    private val runner = ApplicationContextRunner()
        .withInitializer { it.beanFactory.conversionService = ApplicationConversionService.getSharedInstance() }
        // 다른 기능의 풀도 실행 시점 타입이 ThreadPoolExecutor일 수 있다(예: Executors.newFixedThreadPool).
        .withBean("otherFeatureExecutor", ThreadPoolExecutor::class.java, {
            ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, LinkedBlockingQueue())
        })
        .withUserConfiguration(ApplicationDocumentGenerationConfig::class.java, ApplicationDocumentGenerationJobWorker::class.java)
        .withBean(ApplicationDocumentGenerationJobRepository::class.java, { mock(ApplicationDocumentGenerationJobRepository::class.java) })
        .withBean(ApplicationDocumentGenerationJobService::class.java, { mock(ApplicationDocumentGenerationJobService::class.java) })

    @Test
    fun workerUsesItsOwnExecutorEvenWhenAnotherThreadPoolExecutorExists() {
        runner.run {
            assertNull(it.startupFailure)
            val worker = it.getBean(ApplicationDocumentGenerationJobWorker::class.java)
            val executor = ApplicationDocumentGenerationJobWorker::class.java.getDeclaredField("executor").apply { isAccessible = true }.get(worker)
            assertSame(it.getBean("applicationDocumentGenerationExecutor"), executor)
        }
    }

    @Test
    fun disabledJobsRegisterNeitherWorkerNorExecutor() {
        runner.withPropertyValues("app.application-document.jobs.enabled=false").run {
            assertNull(it.startupFailure)
            assertTrue(it.getBeansOfType(ApplicationDocumentGenerationJobWorker::class.java).isEmpty())
            assertTrue(!it.containsBean("applicationDocumentGenerationExecutor"))
        }
    }
}
