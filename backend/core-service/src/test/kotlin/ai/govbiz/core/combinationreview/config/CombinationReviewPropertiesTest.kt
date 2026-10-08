package ai.govbiz.core.combinationreview.config

import ai.govbiz.core.combinationreview.domain.ReviewContractVersion
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner

class CombinationReviewPropertiesTest {
    private val runner = ApplicationContextRunner().withUserConfiguration(CombinationReviewConfig::class.java)

    @Test
    fun newRunsUseV3UnlessV2IsExplicitlySelected() {
        assertEquals(ReviewContractVersion.V3, CombinationReviewProperties().reviewContractVersion)
        assertEquals(ReviewContractVersion.V2, CombinationReviewProperties("v2").reviewContractVersion)
        runner.run { context ->
            assertEquals(ReviewContractVersion.V3, context.getBean(CombinationReviewProperties::class.java).reviewContractVersion)
        }
        runner.withPropertyValues("app.combination-review.contract-version=v2", "app.combination-review.queue.enabled=true").run { context ->
            assertEquals(ReviewContractVersion.V2, context.getBean(CombinationReviewProperties::class.java).reviewContractVersion)
        }
    }

    @Test
    fun startupFailsForAnyOtherContractVersion() {
        for (value in listOf("", "V3", "v4", "combination-review-v3", " v3")) {
            assertThrows(IllegalArgumentException::class.java) { CombinationReviewProperties(value) }
        }
        runner.withPropertyValues("app.combination-review.contract-version=v4").run { context -> assertThat(context).hasFailed() }
    }
}
