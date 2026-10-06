package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentGenerationJobDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationDocumentGenerationJobMapper
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationDbRow
import ai.govbiz.core.applicationpreparation.repository.mapper.ApplicationPreparationMapper
import java.time.Clock
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.Mockito.*
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationPreparationDeletionTest {
    private val preparations = mock(ApplicationPreparationMapper::class.java)
    private val jobs = mock(ApplicationDocumentGenerationJobMapper::class.java)
    private val repository = ApplicationPreparationRepository(preparations, jobs, Clock.systemUTC())
    private val jobRepository = ApplicationDocumentGenerationJobRepository(jobs, preparations, jacksonObjectMapper(), Clock.systemUTC())

    @ParameterizedTest
    @ValueSource(strings = ["QUEUED", "RUNNING", "UNKNOWN"])
    fun activeDocumentJobPreventsDeletion(status: String) {
        `when`(preparations.findOwnedForUpdate(1, 7)).thenReturn(ApplicationPreparationDbRow(id = 7))
        `when`(jobs.findActive(7)).thenReturn(ApplicationDocumentGenerationJobDbRow(id = 9, status = status))

        assertThrows(ApplicationPreparationRunConflictException::class.java) { repository.deleteOwned(1, 7) }
        verify(preparations, never()).deleteOwned(anyLong(), anyLong())
    }

    @Test
    fun ownedPreparationWithoutAnActiveJobCanBeDeleted() {
        `when`(preparations.findOwnedForUpdate(1, 7)).thenReturn(ApplicationPreparationDbRow(id = 7))
        `when`(preparations.deleteOwned(1, 7)).thenReturn(1)
        assertTrue(repository.deleteOwned(1, 7))
    }

    @Test
    fun missingOrUnownedPreparationDoesNotInspectJobsOrDelete() {
        assertFalse(repository.deleteOwned(2, 7))
        verifyNoInteractions(jobs)
        verify(preparations, never()).deleteOwned(anyLong(), anyLong())
    }

    @Test
    fun reservationAfterDeletionReturnsNotFoundWithoutInsertingAJob() {
        `when`(jobs.lockActiveAccount(1)).thenReturn(1)
        assertThrows(ApplicationPreparationNotFoundException::class.java) {
            jobRepository.reserve(1, "11111111-1111-4111-8111-111111111111", 7, 1)
        }
        verify(jobs, never()).insert(any(ApplicationDocumentGenerationJobDbRow::class.java) ?: ApplicationDocumentGenerationJobDbRow())
    }
}
