"""기존 개발 키를 유지하고 Ops 로컬 전용 값을 별도 파일에 생성한다."""

import os
from pathlib import Path
import secrets


def main():
    target = Path(__file__).with_name(".env.ops")
    values = {name: secrets.token_hex(32) for name in (
        "OPS_DB_PASSWORD", "OPS_DB_ROOT_PASSWORD", "OPS_DJANGO_SECRET_KEY", "OPS_ADMIN_PASSWORD",
    )}
    values["OPS_ADMIN_USERNAME"] = "operator"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    print(f"Created {target}. Existing credentials were not changed.")


if __name__ == "__main__":
    main()
