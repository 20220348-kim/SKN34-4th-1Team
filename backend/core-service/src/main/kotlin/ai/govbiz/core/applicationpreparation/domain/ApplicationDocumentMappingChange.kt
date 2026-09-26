package ai.govbiz.core.applicationpreparation.domain

/** Changes that affect where a confirmed fact can be written. Semantic analysis alone is ignored. */
data class ApplicationDocumentMappingChange(
    val factId: String?,
    val type: String,
    val oldTargetIds: List<String>,
    val newTargetIds: List<String>,
)

fun mappingChanges(old: ApplicationDocumentMapSnapshot, next: ApplicationDocumentMapSnapshot): List<ApplicationDocumentMappingChange> {
    val oldByFact = old.bindings.groupBy { it.factId }
    val nextByFact = next.bindings.groupBy { it.factId }
    val changes = (oldByFact.keys + nextByFact.keys).sorted().mapNotNull { factId ->
        val before = oldByFact[factId].orEmpty()
        val after = nextByFact[factId].orEmpty()
        val oldIds = before.map { it.targetId }.sorted()
        val newIds = after.map { it.targetId }.sorted()
        val type = when {
            before.isEmpty() && after.isNotEmpty() -> "TARGET_ADDED"
            before.isNotEmpty() && after.isEmpty() -> "TARGET_REMOVED"
            oldIds != newIds -> "TARGET_CHANGED"
            before.toSet() != after.toSet() -> "BOX_CHANGED"
            oldIds.any { targetId -> targetKind(old, targetId) != targetKind(next, targetId) } -> "KIND_CHANGED"
            oldIds.any { targetId -> targetPosition(old, targetId) != targetPosition(next, targetId) } -> "BOX_CHANGED"
            else -> null
        }
        type?.let { ApplicationDocumentMappingChange(factId, it, oldIds, newIds) }
    }.toMutableList()
    if (old.scopeTargetIds.toSet() != next.scopeTargetIds.toSet()) {
        changes += ApplicationDocumentMappingChange(null, "SCOPE_CHANGED", old.scopeTargetIds.sorted(), next.scopeTargetIds.sorted())
    }
    return changes
}

private fun target(old: ApplicationDocumentMapSnapshot, targetId: String): Map<*, *>? =
    (old.documentMap["targets"] as? List<*>)?.firstNotNullOfOrNull { item ->
        (item as? Map<*, *>)?.takeIf { it["targetId"] == targetId }
    }

private fun targetKind(snapshot: ApplicationDocumentMapSnapshot, targetId: String): String? =
    target(snapshot, targetId)?.get("kind") as? String

private fun targetPosition(snapshot: ApplicationDocumentMapSnapshot, targetId: String): Any? {
    val locator = target(snapshot, targetId)?.get("nativeLocator") as? Map<*, *> ?: return null
    fun normalized(value: Any?): Any? = when (value) {
        is Number -> java.math.BigDecimal(value.toString()).setScale(6, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
        is Map<*, *> -> value.entries.associate { (key, item) -> key.toString() to normalized(item) }.toSortedMap()
        is List<*> -> value.map(::normalized)
        else -> value
    }
    return normalized(mapOf("page" to locator["page"], "box" to locator["box"], "widgets" to locator["widgets"]))
}
