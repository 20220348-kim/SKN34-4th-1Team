package ai.govbiz.core.planusage

import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.PlanUsageService
import java.time.Clock
import java.time.ZoneId
import java.time.ZonedDateTime
import org.mockito.Mockito
import org.mockito.quality.Strictness
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionStatus

/** 요금제 한도와 무관한 흐름을 검증하는 단위 테스트가 쓰는 대역입니다. */
object PlanUsageTestHelper {
    // 엄격한 스텁을 쓰는 테스트에서도 한도와 무관한 요청은 이 대역을 부르지 않을 수 있습니다.
    private val LENIENT = Mockito.withSettings().strictness(Strictness.LENIENT)

    /** 모든 요청을 FREE 한도 안으로 받아들이고 사용량 저장소는 부르지 않는 [PlanUsageService]입니다. */
    fun allowAll(clock: Clock = Clock.system(ZoneId.of("Asia/Seoul"))): PlanUsageService {
        val repository = Mockito.mock(PlanUsageRepository::class.java, LENIENT)
        Mockito.doReturn(PlanCode.FREE).`when`(repository).findPlan(Mockito.anyLong())
        Mockito.doReturn(true).`when`(repository).reserve(
            Mockito.anyLong(),
            Mockito.any(PlanUsageFeature::class.java) ?: PlanUsageFeature.AI_SEARCH,
            Mockito.anyString(),
            Mockito.any(),
        )
        val guests = Mockito.mock(GuestPlanUsageRepository::class.java, LENIENT)
        val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, ZonedDateTime.now(clock))
        Mockito.doReturn(true).`when`(guests).reserve(
            Mockito.anyString(),
            Mockito.any(PlanUsageWindow::class.java) ?: window,
            Mockito.anyInt(),
        )
        return PlanUsageService(repository, guests, clock, noTransactions(), Mockito.mock(AccountRepository::class.java), "")
    }

    /** TransactionTemplate가 부를 때 아무 일도 하지 않는 transaction 관리자입니다. 콜백에는 빈 transaction 상태를 넘깁니다. */
    fun noTransactions(): PlatformTransactionManager = Mockito.mock(PlatformTransactionManager::class.java, LENIENT).also {
        Mockito.doReturn(Mockito.mock(TransactionStatus::class.java)).`when`(it).getTransaction(Mockito.any())
    }
}
