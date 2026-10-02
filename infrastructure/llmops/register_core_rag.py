"""검증된 Core 무료 캡처를 중지된 배포 checkout의 저장 재평가 목록에 등록한다."""

import argparse
import json
import shutil
import sys
from pathlib import Path

import core_rag_budget as planner

sys.path.insert(0, str(planner.ROOT / "backend/ops-service"))
from apps.evaluations.execution_spec import (  # noqa: E402
    EVIDENCE,
    OPS,
    build_release,
    digest,
)


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def register(directory, repository):
    """DB·서버에 접속하지 않는다. 목록과 release를 함께 검토·배포해야 한다."""
    directory, repository = Path(directory).resolve(), Path(repository).resolve()
    plan = planner.build_plan(directory)
    for relative, expected in plan["preparationSha256"].items():
        planner.rag.require(
            planner.rag.digest((repository / relative).read_bytes()) == expected,
            "Registration checkout differs from the validating source",
        )
    identifier = "core-rag-" + digest(plan["sourceSha256"])
    relative = Path("runs") / identifier
    destination = repository / EVIDENCE / relative
    catalog_path = repository / OPS / "capture_catalog.json"
    release_path = repository / OPS / "execution_release.json"
    # Concurrent registrations must not overwrite each other's catalog or release.
    lock = repository / OPS / ".core-rag-registration.lock"
    with lock.open("x") as registration_lock:
        try:
            original_catalog, original_release = (
                catalog_path.read_bytes(),
                release_path.read_bytes(),
            )
            release = build_release(repository)
            planner.rag.require(
                json.loads(original_release) == release,
                "Execution release is stale; review it before registration",
            )
            planner.rag.require(
                all(
                    planner.rag.digest((planner.ROOT / path).read_bytes()) == expected
                    for path, expected in release["rag_evaluation"]["files"].items()
                ),
                "Registration evaluator differs from the deployment release",
            )
            catalog = json.loads(original_catalog)
            planner.rag.require(
                not any(item["id"] == identifier for item in catalog),
                "Core capture is already registered",
            )
            destination.mkdir(parents=True, exist_ok=False)
            try:
                source = destination / "source"
                source.mkdir()
                for name in ("fixture", "capture", "wire", "integration"):
                    input_path = (
                        directory.parent if name == "integration" else directory
                    ) / f"{name}.json"
                    raw = input_path.read_bytes()
                    planner.rag.require(
                        planner.rag.digest(raw) == plan["sourceSha256"][name],
                        "Core input changed during registration",
                    )
                    (destination if name == "integration" else source).joinpath(
                        f"{name}.json"
                    ).write_bytes(raw)
                # Revalidate the exact copied bytes; never register a reserialized capture.
                planner.rag.require(
                    planner.build_plan(source) == plan, "Copied Core evidence differs"
                )
                report = planner.rag.evaluate(source / "fixture.json", source / "capture.json")
                entry = {
                    "id": identifier,
                    "label": f"전체 RAG · Core 무료 대역 캡처 {report['caseCount']}건 · 미검토",
                    "evaluation_scope": "source-chunks-retrieval-answer",
                    "fixture": (relative / "source/fixture.json").as_posix(),
                    "fixture_sha256": plan["sourceSha256"]["fixture"],
                    "case_ids": [case["caseId"] for case in report["cases"]],
                    "captures": [
                        {
                            "id": identifier,
                            "label": "Core 통합 대역 · 실패 사례 포함 · 실제 모델 품질 아님",
                            "path": (relative / "source/capture.json").as_posix(),
                        }
                    ],
                }
                receipt = {
                    "schema_version": 1,
                    "dataset_id": identifier,
                    "capture_id": identifier,
                    "source_sha256": plan["sourceSha256"],
                    "report": report,
                }
                (destination / "registration.json").write_bytes(encode(receipt))
                catalog_path.write_bytes(encode([*catalog, entry]))
                release_path.write_bytes(encode(build_release(repository)))
            except BaseException:
                catalog_path.write_bytes(original_catalog)
                release_path.write_bytes(original_release)
                shutil.rmtree(destination)
                raise
            return destination / "registration.json"
        finally:
            registration_lock.close()
            lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="완료된 Core 수집의 v1 또는 v2 디렉터리")
    parser.add_argument(
        "--repository", type=Path, required=True, help="서버가 사용하지 않는 배포 준비 checkout"
    )
    args = parser.parse_args()
    print(register(args.directory, args.repository))


if __name__ == "__main__":
    main()
