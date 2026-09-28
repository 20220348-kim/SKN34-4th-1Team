"""Ops 로컬 비밀값과 CI Core fixture 비밀번호를 생성한다. 기존 파일은 덮어쓰지 않는다."""

import os
from pathlib import Path
import secrets


def main():
    target = Path(__file__).with_name(".env.ops")
    values = {name: secrets.token_hex(32) for name in (
        "OPS_DB_PASSWORD", "OPS_DB_ROOT_PASSWORD", "OPS_DJANGO_SECRET_KEY", "OPS_ADMIN_PASSWORD",
        "LLMOPS_BUDGET_TOKEN",
    )}
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    print(f"Created {target}. Existing credentials were not changed.")


if __name__ == "__main__":
    main()
