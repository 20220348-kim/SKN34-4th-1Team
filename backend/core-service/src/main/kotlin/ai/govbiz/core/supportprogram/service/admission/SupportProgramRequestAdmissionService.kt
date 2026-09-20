package ai.govbiz.core.supportprogram.service.admission

import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException
import ai.govbiz.core.supportprogram.service.admission.exception.SupportProgramRequestRejectedException.Reason
import java.util.ArrayDeque

/** 한 Core API 프로세스에서 검색·공고 질문·공식 양식 발견·중복 검토의 요청량 및 동시 실행을 함께 제한합니다. */
class SupportProgramRequestAdmissionService(
    private val properties: SupportProgramRequestAdmissionProperties,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private val lock = Any()
    private val acceptedRequests = ArrayDeque<AcceptedRequest>()
    private val clientCounts = mutableMapOf<String, Int>()
    private var activeRequests = 0

    fun <T> execute(clientAddress: String, action: () -> T): T {
        synchronized(lock) {
            val now = nanoTime()
            expireRequests(now)

            val clientLimitReached = (clientCounts[clientAddress] ?: 0) >= properties.perClientPerMinute
            val globalLimitReached = acceptedRequests.size >= properties.globalPerMinute
            if (clientLimitReached || globalLimitReached) {
                val clientWait = if (clientLimitReached) {
                    remainingNanos(acceptedRequests.first { it.clientAddress == clientAddress }, now)
                } else {
                    0L
                }
                val globalWait = if (globalLimitReached) {
                    remainingNanos(acceptedRequests.first, now)
                } else {
                    0L
                }
                val retryAfterSeconds = ((maxOf(clientWait, globalWait) + SECOND_NANOS - 1) / SECOND_NANOS).toInt()
                throw SupportProgramRequestRejectedException(Reason.RATE_LIMITED, retryAfterSeconds)
            }
            if (activeRequests >= properties.maxConcurrent) {
                throw SupportProgramRequestRejectedException(Reason.BUSY, 1)
            }

            // 거절한 요청은 기록하지 않아 IP 수와 이벤트 수가 글로벌 분당 한도를 넘지 않습니다.
            acceptedRequests.addLast(AcceptedRequest(now, clientAddress))
            clientCounts[clientAddress] = (clientCounts[clientAddress] ?: 0) + 1
            activeRequests += 1
        }

        return runWithReservedSlot(action)
    }

    /** 이미 접수 횟수를 계산한 큐 작업은 공유 실행 슬롯만 사용한다. 대기는 작업 Outbox가 담당한다. */
    fun <T> executeBackground(action: () -> T): T {
        synchronized(lock) {
            if (activeRequests >= properties.maxConcurrent) {
                throw SupportProgramRequestRejectedException(Reason.BUSY, 1)
            }
            activeRequests += 1
        }
        return runWithReservedSlot(action)
    }

    private fun <T> runWithReservedSlot(action: () -> T): T {
        try {
            return action()
        } finally {
            synchronized(lock) {
                activeRequests -= 1
            }
        }
    }

    private fun expireRequests(now: Long) {
        while (acceptedRequests.isNotEmpty() && now - acceptedRequests.first.acceptedAtNanos >= WINDOW_NANOS) {
            val expired = acceptedRequests.removeFirst()
            val remaining = clientCounts.getValue(expired.clientAddress) - 1
            if (remaining == 0) {
                clientCounts.remove(expired.clientAddress)
            } else {
                clientCounts[expired.clientAddress] = remaining
            }
        }
    }

    private fun remainingNanos(request: AcceptedRequest, now: Long): Long =
        WINDOW_NANOS - (now - request.acceptedAtNanos)

    private data class AcceptedRequest(val acceptedAtNanos: Long, val clientAddress: String)

    private companion object {
        const val SECOND_NANOS = 1_000_000_000L
        const val WINDOW_NANOS = 60 * SECOND_NANOS
    }
}
