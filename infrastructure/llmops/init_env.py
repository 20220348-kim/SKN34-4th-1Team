"""개발 전용 비밀 값을 생성한다. 기존 파일은 덮어쓰지 않으며 값은 출력하지 않는다."""

import os
from pathlib import Path
import secrets


def main() -> None:
    target = Path(__file__).with_name(".env")
    values = {name: secrets.token_hex(32) for name in (
        "POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "REDIS_PASSWORD", "MINIO_PASSWORD",
        "LANGFUSE_SALT", "LANGFUSE_ENCRYPTION_KEY", "LANGFUSE_NEXTAUTH_SECRET", "LANGFUSE_ADMIN_PASSWORD",
    )}
    values.update(
        LANGFUSE_PUBLIC_KEY="pk-lf-" + secrets.token_hex(16),
        LANGFUSE_SECRET_KEY="sk-lf-" + secrets.token_hex(32),
        LANGFUSE_BASE_URL="http://localhost:13000",
        LANGFUSE_ENABLED="true",
        LANGFUSE_ENVIRONMENT="development",
        PREFECT_API_URL="http://localhost:14200/api",
        PREFECT_SERVER_ANALYTICS_ENABLED="false",
    )
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    print(f"Created {target}. Keep this local; credentials were not printed.")


if __name__ == "__main__":
    main()
