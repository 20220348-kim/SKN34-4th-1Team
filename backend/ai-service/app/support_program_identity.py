import re
from unicodedata import category


MAX_CANONICAL_SOURCE_PROGRAM_ID_LENGTH = 320
MAX_SOURCE_CODE_LENGTH = 64
MAX_SOURCE_PROGRAM_ID_LENGTH = 255
SOURCE_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def require_canonical_source_program_id(value: object) -> object:
    """색인과 점수화 경계가 함께 쓰는 sourceCode:sourceProgramId 규칙."""
    if not isinstance(value, str):
        return value

    source_code, separator, source_program_id = value.partition(":")
    if (
        not separator
        or value != value.strip()
        or len(source_code) > MAX_SOURCE_CODE_LENGTH
        or len(source_program_id) > MAX_SOURCE_PROGRAM_ID_LENGTH
        or not SOURCE_CODE_PATTERN.fullmatch(source_code)
        or not source_program_id
        or source_program_id != source_program_id.strip()
        or any(category(character).startswith("C") for character in value)
    ):
        raise ValueError("id must be canonical sourceCode:sourceProgramId")
    return value
