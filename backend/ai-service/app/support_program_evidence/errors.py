class SupportProgramEvidenceError(RuntimeError):
    """상세 공고 근거 검색·답변 경계의 안전한 오류."""

    def __init__(self, code: str = "EVIDENCE_UNAVAILABLE") -> None:
        super().__init__(code)
        self.code = code
