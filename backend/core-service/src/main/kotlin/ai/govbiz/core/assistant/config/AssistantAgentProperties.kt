package ai.govbiz.core.assistant.config

import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * 도우미 도구 에이전트 설정입니다. 도구 API는 AI Service만 부르는 내부 읽기 경로라 공유 비밀과
 * 계정을 묶은 단기 토큰 둘 다 있어야 열립니다. 비밀이 비어 있으면 도구 API 전체가 닫힙니다.
 */
@ConfigurationProperties(prefix = "app.assistant")
data class AssistantAgentProperties(
    /** 자유 질문을 도구 에이전트 경로로 보낼지입니다. 꺼져 있으면 기존 의도 분류만 씁니다. */
    val agentEnabled: Boolean = false,
    /** Core와 AI Service가 공유하는 비밀입니다. 32자 미만이면 도구 API를 닫습니다. */
    val toolsSecret: String = "",
    /** 요청마다 발급하는 계정 묶음 토큰의 유효 시간입니다. */
    val toolTokenTtl: Duration = Duration.ofMinutes(5),
    /** 에이전트 경로만의 추가 한도입니다. 기존 도우미 한도 위에 얹힙니다. */
    val agentPerClientPerMinute: Int = 3,
    /** 관심 공고 묶음 질문에서 원문 확보·색인에 쓰는 전체 예산입니다. 넘긴 공고는 '원문 미확인'으로 보냅니다. */
    val documentPrepareTimeout: Duration = Duration.ofSeconds(6),
    /** 관심 공고를 담을 때 원문을 미리 수집·색인하는 큐(RabbitMQ)를 켭니다. */
    val prefetchQueueEnabled: Boolean = false,
) {
    init {
        require(!toolTokenTtl.isNegative && !toolTokenTtl.isZero && toolTokenTtl <= Duration.ofHours(1)) {
            "app.assistant.tool-token-ttl must be between 1 second and 1 hour"
        }
        require(documentPrepareTimeout in Duration.ofSeconds(1)..Duration.ofSeconds(30)) { "app.assistant.document-prepare-timeout must be 1~30 seconds" }
        require(agentPerClientPerMinute in 1..1_000) { "app.assistant.agent-per-client-per-minute must be between 1 and 1000" }
        require(!agentEnabled || toolsEnabled) { "app.assistant.tools-secret must be at least $MIN_SECRET_LENGTH characters when the agent is enabled" }
    }

    val toolsEnabled: Boolean
        get() = toolsSecret.length >= MIN_SECRET_LENGTH

    companion object {
        const val MIN_SECRET_LENGTH = 32
    }
}
