package ai.govbiz.core.supportprogram.service.projection

import ai.govbiz.core.supportprogram.client.catalog.CatalogSnapshotClient
import ai.govbiz.core.supportprogram.repository.CatalogProjectionRepository
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

@Service
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "true")
class CatalogProjectionService(
    private val client: CatalogSnapshotClient,
    private val repository: CatalogProjectionRepository,
    transactionManager: PlatformTransactionManager,
) {
    private val transaction = TransactionTemplate(transactionManager)

    /** HTTP 수신을 끝낸 뒤 공고·신청서 상태·checkpoint의 transaction을 Service가 시작하고 완료합니다. */
    fun synchronize(sourceCode: String): Boolean {
        val snapshot = client.fetch(sourceCode)
        return requireNotNull(transaction.execute { repository.apply(snapshot) })
    }
}
