package ai.govbiz.core.account.service

import ai.govbiz.core.account.client.oauth.AccountOAuthUnlinkQueueClient
import ai.govbiz.core.account.repository.AccountOAuthUnlinkRepository
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 큐 모드는 ID를 발행하고, 큐 없는 개발 환경은 같은 DB 작업을 직접 실행한다. 브로커 장애 시 직접 실행으로 우회하지 않는다. */
@Component
@ConditionalOnProperty(prefix = "app.account.oauth.unlink", name = ["enabled"], havingValue = "true")
class AccountOAuthUnlinkScheduler(
    private val repository: AccountOAuthUnlinkRepository,
    private val service: AccountOAuthUnlinkService,
    private val client: ObjectProvider<AccountOAuthUnlinkQueueClient>,
    @param:Value("\${app.account.oauth.unlink.queue-enabled:false}") private val queueEnabled: Boolean,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "PT5S", initialDelayString = "PT5S", scheduler = "accountOAuthUnlinkTaskScheduler")
    fun dispatch() {
        try {
            repository.expireRunning()
            for (id in repository.pending()) {
                if (!queueEnabled) {
                    service.execute(id)
                } else if (repository.reservePublication(id)) {
                    client.getObject().publish(id)
                    repository.markPublished(id)
                }
            }
        } catch (_: Exception) {
            log.warn("OAuth unlink dispatch failed; durable work retained for retry or operator review")
        }
    }
}
