from app.assistant.errors import AssistantAnswerError, AssistantAnswerTimeoutError


class AssistantAgentError(AssistantAnswerError):
    """모델 장애 또는 도우미 에이전트 응답의 계약 위반. 라우터는 기존 도우미와 같은 503으로 바꾼다."""


class AssistantAgentTimeoutError(AssistantAnswerTimeoutError):
    """에이전트 전체 실행 제한 시간이 소진된 오류. 라우터는 504로 바꾼다."""


class ToolCallError(RuntimeError):
    """Core 내부 도구 호출 실패. 도구 노드가 잡아 ok=false로 기록하고 답을 강등한다."""
