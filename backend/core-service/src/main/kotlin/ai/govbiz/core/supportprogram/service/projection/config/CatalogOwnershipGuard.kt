package ai.govbiz.core.supportprogram.service.projection.config

import ai.govbiz.core.supportprogram.repository.CatalogProjectionRepository
import org.springframework.beans.factory.SmartInitializingSingleton
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component

/** 원격 소유권 전환 후 플래그 하나만 꺼서 Core 수집기가 다시 원본을 쓰지 못하게 합니다. */
@Component
class CatalogOwnershipGuard(
    private val repository: CatalogProjectionRepository,
    @param:Value("\${app.catalog.projection.enabled:false}") private val remoteEnabled: Boolean,
) : SmartInitializingSingleton {
    override fun afterSingletonsInstantiated() {
        check(remoteEnabled || !repository.hasCheckpoints()) {
            "Catalog ownership has moved to the remote service; keep CATALOG_PROJECTION_ENABLED=true. Reverting ownership requires an explicit migration."
        }
    }
}
