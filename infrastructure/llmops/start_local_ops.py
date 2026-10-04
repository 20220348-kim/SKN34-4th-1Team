"""Start local Ops; Compose bootstraps Git-shared reviews only on an empty database."""

import subprocess
import sys
from pathlib import Path


def main():
    directory = Path(__file__).resolve().parent
    for filename, script in ((".env", "init_env.py"), (".env.ops", "init_ops_env.py")):
        if not (directory / filename).exists():
            subprocess.run([sys.executable, str(directory / script)], check=True)
    subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(directory / ".env"),
            "--env-file",
            str(directory / ".env.ops"),
            "-f",
            str(directory / "compose.yaml"),
            "-f",
            str(directory / "compose.ops.yaml"),
            "--profile",
            "evaluation",
            "up",
            "-d",
            "--build",
            "ops-service",
        ],
        check=True,
    )
    print("Ops: http://127.0.0.1:18001 · React: pnpm dev:web · 기존 Core 관리자 로그인 사용")


if __name__ == "__main__":
    main()
