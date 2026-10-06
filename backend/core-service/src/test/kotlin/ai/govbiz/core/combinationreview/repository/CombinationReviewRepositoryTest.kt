package ai.govbiz.core.combinationreview.repository

import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewDeleteConflictException
import ai.govbiz.core.combinationreview.repository.mapper.CombinationReviewMapper
import java.time.Clock
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.inOrder
import org.mockito.Mockito.mock
import org.mockito.Mockito.verifyNoMoreInteractions

class CombinationReviewRepositoryTest {
    private val mapper = mock(CombinationReviewMapper::class.java)
    private val repository = CombinationReviewRepository(mapper, Clock.systemUTC())

    @Test
    fun missingOrForeignReviewDoesNotReadRunsOrDeleteAnything() {
        doReturn(null).`when`(mapper).lockOwnedReview(1, 2)
        assertFalse(repository.deleteOwned(1, 2))
        val calls = inOrder(mapper)
        calls.verify(mapper).lockOwnedReview(1, 2)
        verifyNoMoreInteractions(mapper)
    }

    @Test
    fun blockingRunKeepsTheReviewAndItsChildrenAfterAcquiringTheParentLock() {
        doReturn(2L).`when`(mapper).lockOwnedReview(1, 2)
        doReturn(3L).`when`(mapper).findDeletionBlockingRun(2)
        assertThrows(CombinationReviewDeleteConflictException::class.java) { repository.deleteOwned(1, 2) }
        val calls = inOrder(mapper)
        calls.verify(mapper).lockOwnedReview(1, 2)
        calls.verify(mapper).findDeletionBlockingRun(2)
        verifyNoMoreInteractions(mapper)
    }

    @Test
    fun deletesOnlyAfterTheOwnedReviewIsLockedAndNoBlockingRunIsFound() {
        doReturn(2L).`when`(mapper).lockOwnedReview(1, 2)
        doReturn(null).`when`(mapper).findDeletionBlockingRun(2)
        doReturn(1).`when`(mapper).deleteReview(1, 2)
        assertTrue(repository.deleteOwned(1, 2))
        val calls = inOrder(mapper)
        calls.verify(mapper).lockOwnedReview(1, 2)
        calls.verify(mapper).findDeletionBlockingRun(2)
        calls.verify(mapper).deleteReview(1, 2)
        verifyNoMoreInteractions(mapper)
    }
}
