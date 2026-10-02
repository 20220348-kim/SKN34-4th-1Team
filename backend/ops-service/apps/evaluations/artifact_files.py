"""허용된 평가 파일의 경로와 크기를 제한한다. Django·평가 SDK에 의존하지 않는다."""

import os
import re
import stat
from contextlib import ExitStack
from pathlib import Path
from uuid import UUID

from .catalog import DATASETS

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_RECEIPT_BYTES = 8 * 1024
RESULT_FILES = frozenset(
    {
        "request.json",
        "preflight.json",
        "evaluation/manifest.json",
        "evaluation/comparison.json",
        "evaluation/report.html",
        "capture/capture.json",
        "reference-capture.json",
        "recovery-fixture.json",
    }
)
EVIDENCE_FILES = frozenset(
    name
    for dataset in DATASETS.values()
    for name in [dataset["fixture"], *[item["path"] for item in dataset["captures"]]]
)


def validate_token(token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("A separate random artifact token of 32 to 256 characters is required")


def result_name(run_id, name):
    identifier = str(run_id)
    if str(UUID(identifier)) != identifier or name not in RESULT_FILES:
        raise ValueError("Invalid artifact selection")
    return f"{identifier}/{name}"


def receipt_name(run_id, sequence):
    identifier = str(run_id)
    if str(UUID(identifier)) != identifier or type(sequence) is not int or not 0 <= sequence <= 511:
        raise ValueError("Invalid usage receipt selection")
    return f"{identifier}/capture/usage-{sequence}.json"


def read_file(root, name, *, max_bytes=MAX_FILE_BYTES):
    if (
        not name
        or "\\" in name
        or Path(name).drive
        or any(part in {"", ".", ".."} for part in name.split("/"))
    ):
        raise ValueError("Invalid artifact path")
    root = Path(root).resolve(strict=True)
    path = root / name
    with ExitStack() as stack:
        if os.open in os.supports_dir_fd:
            # Linux containers: pin every directory descriptor and reject symlink races.
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            descriptor = os.open(root, flags | os.O_DIRECTORY)
            stack.callback(os.close, descriptor)
            for part in name.split("/")[:-1]:
                descriptor = os.open(part, flags | os.O_DIRECTORY, dir_fd=descriptor)
                stack.callback(os.close, descriptor)
            descriptor = os.open(name.split("/")[-1], flags, dir_fd=descriptor)
            source = stack.enter_context(os.fdopen(descriptor, "rb"))
        else:
            # Windows development checks; deployed storage is always the Linux image.
            for part in name.split("/"):
                root = root / part
                if root.is_symlink():
                    raise ValueError("Artifact links are forbidden")
            if not path.is_file():
                raise ValueError("Artifact is not a regular file")
            source = stack.enter_context(path.open("rb"))
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ValueError("Artifact is not a bounded regular file")
        raw = source.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("Artifact is too large")
    return raw
