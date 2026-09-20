package ai.govbiz.core._common.config

import java.time.Clock
import java.time.ZoneId
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 지원사업 접수 상태 계산과 계정 세션 만료 판단이 함께 쓰는 서울 기준 시계를 제공합니다. */
@Configuration(proxyBeanMethods = false)
class SeoulClockConfig {

    @Bean
    fun seoulClock(): Clock = Clock.system(SEOUL_ZONE)

    private companion object {
        val SEOUL_ZONE: ZoneId = ZoneId.of("Asia/Seoul")
    }
}
