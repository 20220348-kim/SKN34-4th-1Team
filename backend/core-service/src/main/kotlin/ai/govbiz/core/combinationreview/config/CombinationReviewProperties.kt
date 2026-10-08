package ai.govbiz.core.combinationreview.config

import ai.govbiz.core.combinationreview.domain.ReviewContractVersion
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 중복 검토 설정입니다. 큐 사용 여부(`app.combination-review.queue.enabled`)는 큐 구성 요소가 따로 읽습니다.
 * 계약 버전은 새 분석 실행에만 적용하며, 지난 실행은 저장된 설정의 계약 버전으로 그대로 읽습니다.
 */
@ConfigurationProperties(prefix = "app.combination-review")
data class CombinationReviewProperties(
    /** 새 분석 실행이 따르는 AI 계약입니다. `v2`(여섯 단계) 또는 `v3`(세 질문)만 허용합니다. */
    val contractVersion: String = "v2",
) {
    init {
        require(contractVersion in VERSIONS) { "app.combination-review.contract-version must be v2 or v3" }
    }

    val reviewContractVersion: ReviewContractVersion
        get() = VERSIONS.getValue(contractVersion)

    private companion object {
        val VERSIONS = mapOf("v2" to ReviewContractVersion.V2, "v3" to ReviewContractVersion.V3)
    }
}
