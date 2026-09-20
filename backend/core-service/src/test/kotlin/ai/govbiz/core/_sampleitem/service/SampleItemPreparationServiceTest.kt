package ai.govbiz.core._sampleitem.service

import ai.govbiz.core._sampleitem.domain.ProcessingStatus
import ai.govbiz.core._sampleitem.domain.SampleCategory
import ai.govbiz.core._sampleitem.domain.SampleItem
import ai.govbiz.core._sampleitem.domain.SampleItemPhase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SampleItemPreparationServiceTest {

    private val service = SampleItemPreparationService()

    @Test
    fun createsAReadySnapshotWithoutStartingProcessing() {
        val item = SampleItem.create(
            " Example item ",
            SampleCategory.EXTENDED,
            " A reusable example ",
        )

        val result = service.prepare(item)

        assertEquals(SampleItemPhase.READY_FOR_PROCESSING, result.phase)
        assertEquals(ProcessingStatus.NOT_STARTED, result.processingStatus)
        assertSame(item, result.item)
        assertEquals("Example item", result.item.name)
    }

    @Test
    fun preservesNonBreakingSpaceWhileStrippingJavaWhitespace() {
        val item = SampleItem.create("\u00a0", null, "\u2003")

        assertEquals("\u00a0", item.name)
        assertNull(item.note)
    }

    @Test
    fun rejectsBlankNamesAtTheDomainBoundary() {
        assertThrows(IllegalArgumentException::class.java) {
            SampleItem.create(" ", null, null)
        }
    }
}
