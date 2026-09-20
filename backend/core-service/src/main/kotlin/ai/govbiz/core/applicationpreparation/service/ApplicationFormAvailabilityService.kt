package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
class ApplicationFormAvailabilityService(private val repository: ApplicationFormAvailabilityRepository) {
    @Transactional(readOnly = true)
    fun get(sourceCode: String, sourceProgramId: String): Pair<ApplicationFormAvailability, List<ApplicationFormManifest>> {
        require(Regex("[A-Z][A-Z0-9_]{0,63}").matches(sourceCode) && sourceProgramId.isNotBlank() && sourceProgramId.length <= 255)
        val state = repository.find(sourceCode, sourceProgramId) ?: ApplicationFormAvailability(sourceCode, sourceProgramId,
            ApplicationFormAvailabilityStatus.PENDING, "NOT_ANALYZED", null, null, null, null, null, null, null, 0)
        return state to repository.activeForms(sourceCode, sourceProgramId)
    }
}
