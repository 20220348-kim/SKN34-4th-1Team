package ai.govbiz.core.applicationpreparation.domain

import java.time.LocalDateTime

data class ApplicationContentFact(val fieldKey: String, val status: String, val value: String?)

data class ApplicationContentVersion(
    val id: Long,
    val sectionKey: String,
    val inputRevision: Long,
    val kind: String,
    val content: String,
    val facts: List<ApplicationContentFact>,
    val createdAt: LocalDateTime,
    val confirmedAt: LocalDateTime?,
) {
    fun isStale(current: List<ConfirmedApplicationFact>): Boolean = facts != snapshot(current.filter { it.sectionKey == sectionKey })

    companion object {
        fun snapshot(facts: List<ConfirmedApplicationFact>) = facts.sortedBy { it.fieldKey }
            .map { ApplicationContentFact(it.fieldKey, it.status.name, it.value) }
    }
}

data class ApplicationDraftReservation(val id: Long, val completed: Boolean, val applied: Boolean)

data class ApplicationDraftInput(
    val preparationId: Long,
    val inputRevision: Long,
    val formVersionId: String,
    val serviceField: String,
    val section: ApplicationFormSectionDefinition,
    val facts: List<ApplicationContentFact>,
)

data class ApplicationDraftOutput(
    val content: String,
    val model: String,
    val promptVersion: String,
    val usedFieldKeys: List<String>,
)
