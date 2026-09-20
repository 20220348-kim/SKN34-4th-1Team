class SupportProgramConversationError(Exception):
    """모델 장애 또는 조건 변경안의 계약 위반."""


class SupportProgramConversationTimeoutError(SupportProgramConversationError):
    """조건 해석의 모델·HTTP 또는 전체 실행 제한 시간이 소진된 오류."""
