from enum import StrEnum


class AgentFailureCode(StrEnum):
    EXECUTION_FAILED = "EXECUTION_FAILED"
    MODEL_OUTPUT_INVALID_JSON = "MODEL_OUTPUT_INVALID_JSON"
    MODEL_OUTPUT_SCHEMA_MISMATCH = "MODEL_OUTPUT_SCHEMA_MISMATCH"
    CANDIDATE_SET_MISMATCH = "CANDIDATE_SET_MISMATCH"
    TRUNCATED_SOURCE_KNOWN_ELIGIBILITY = "TRUNCATED_SOURCE_KNOWN_ELIGIBILITY"
    MISSING_KNOWN_EVIDENCE = "MISSING_KNOWN_EVIDENCE"
    EXACT_QUOTE_MISMATCH = "EXACT_QUOTE_MISMATCH"
    UNEXPECTED_OUTPUT_TYPE = "UNEXPECTED_OUTPUT_TYPE"
    INVALID_EVIDENCE_SELECTION = "INVALID_EVIDENCE_SELECTION"


class AgentExecutionError(RuntimeError):
    """Agent가 정상적인 결과를 만들지 못했을 때의 공통 경계 오류."""

    def __init__(self, *args: object, reason_code: AgentFailureCode = AgentFailureCode.EXECUTION_FAILED) -> None:
        super().__init__(*args)
        self.reason_code = reason_code


class AgentTimeoutError(AgentExecutionError):
    """랭킹 모델 또는 전체 실행의 시간 예산이 소진된 오류."""
