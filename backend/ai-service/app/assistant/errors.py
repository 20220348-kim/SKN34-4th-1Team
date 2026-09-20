class AssistantAnswerError(Exception):
    """모델 장애 또는 도우미 답변의 계약 위반."""


class AssistantAnswerTimeoutError(AssistantAnswerError):
    """도우미 답변의 모델·HTTP 또는 전체 실행 제한 시간이 소진된 오류."""
