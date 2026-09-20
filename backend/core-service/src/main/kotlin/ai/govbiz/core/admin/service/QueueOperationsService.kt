package ai.govbiz.core.admin.service

import ai.govbiz.core.admin.client.QueueOperationsClient
import ai.govbiz.core.account.config.AccountOAuthUnlinkRabbitConfig
import ai.govbiz.core.admin.domain.QueueOperationsStatus
import ai.govbiz.core.admin.repository.QueueOperationsRepository
import ai.govbiz.core.applicationpreparation.config.ApplicationFormDiscoveryRabbitConfig
import ai.govbiz.core.combinationreview.config.CombinationReviewRabbitConfig
import ai.govbiz.core.dailyreport.config.DailyReportRabbitConfig
import ai.govbiz.core.dailyreport.config.DailyReportDeliveryRabbitConfig
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service

@Service
class QueueOperationsService(
    private val repository: QueueOperationsRepository,
    private val client: QueueOperationsClient,
    @param:Value("\${app.daily-report.queue.enabled:false}") private val reportsEnabled: Boolean,
    @param:Value("\${app.combination-review.queue.enabled:false}") private val reviewsEnabled: Boolean,
    @param:Value("\${app.application-form-discovery.queue.enabled:false}") private val discoveryEnabled: Boolean,
    @param:Value("\${app.daily-report.queue.delivery-enabled:false}") private val deliveryEnabled: Boolean,
    @param:Value("\${app.account.oauth.unlink.enabled:true}") private val unlinkEnabled: Boolean,
    @param:Value("\${app.account.oauth.unlink.queue-enabled:false}") private val unlinkQueueEnabled: Boolean,
) {
    fun status(): List<QueueOperationsStatus> {
        val counts = repository.counts()
        fun read(feature: String, enabled: Boolean, queue: String, dead: String) = QueueOperationsStatus(
            feature, enabled, if (enabled) client.read(queue) else null, if (enabled) client.read(dead) else null,
            counts[feature].orEmpty(),
        )
        return listOf(
            read("daily-report", reportsEnabled, DailyReportRabbitConfig.QUEUE, DailyReportRabbitConfig.DEAD_QUEUE),
            read("combination-review", reviewsEnabled, CombinationReviewRabbitConfig.QUEUE, CombinationReviewRabbitConfig.DEAD_QUEUE),
            read("application-form-discovery", discoveryEnabled, ApplicationFormDiscoveryRabbitConfig.QUEUE, ApplicationFormDiscoveryRabbitConfig.DEAD_QUEUE),
            read("daily-report-delivery", deliveryEnabled, DailyReportDeliveryRabbitConfig.QUEUE, DailyReportDeliveryRabbitConfig.DEAD_QUEUE),
            read("account-oauth-unlink", unlinkEnabled && unlinkQueueEnabled, AccountOAuthUnlinkRabbitConfig.QUEUE, AccountOAuthUnlinkRabbitConfig.DEAD_QUEUE),
        )
    }
}
