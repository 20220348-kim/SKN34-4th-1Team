#!/usr/bin/env python3
"""Explicit, append-only RDS demo seeding. Default operation is a read-only plan.

Run on the EC2 host with Python 3, Docker Compose and the MySQL client already installed.
Never called from Compose startup, CodeBuild or application startup.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit


SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
SEED_NAMES = ("production-public.sql", "application-preparations.sql", "combination-reviews.sql")
EMAILS = (
    "admin@govbiz.local", "member@govbiz.local", "jihoon.park@demo.govbiz.local",
    "hana.choi@demo.govbiz.local", "dohyun.jung@demo.govbiz.local", "yuna.kang@demo.govbiz.local",
)
LOCK_NAME = "govbiz-personal-demo-seed-v1"
PRIVATE_ENV = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_CONFIG") if key in os.environ}


def sql_text(value):
    return "CONVERT(X'" + value.encode("utf-8").hex() + "' USING utf8mb4)"


def seed_fingerprint():
    digest = hashlib.sha256(Path(__file__).read_bytes())
    for name in SEED_NAMES:
        digest.update((SEED_DIR / name).read_bytes())
    return digest.hexdigest()


def personal_body(sql):
    """The manual runner owns the one transaction and shared lock for all three seeds.

    Fail closed if the two reviewed standalone scripts change their transaction envelope.
    The original scripts (including local forced-reset behaviour) are left untouched.
    """
    for statement in (
        f"SET @personal_demo_seed_lock_acquired := GET_LOCK('{LOCK_NAME}', 60);",
        "START TRANSACTION;", "COMMIT;", f"DO RELEASE_LOCK('{LOCK_NAME}');",
    ):
        if sql.splitlines().count(statement) != 1:
            raise ValueError("개인 시드 트랜잭션 구조가 바뀌었습니다. 실행 전에 검토하세요.")
        sql = sql.replace(statement + "\n", "", 1)
    if re.search(r"(?im)^\s*(START\s+TRANSACTION|BEGIN|COMMIT\b|ROLLBACK\b|SET\s+autocommit|(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?!TEMPORARY\b))", sql):
        raise ValueError("개인 시드에 외부 트랜잭션과 호환되지 않는 명령이 있습니다.")
    return sql


def build_sql(program_ids, hashes):
    if len(program_ids) != 5 or len(set(program_ids)) != 5 or any(type(n) is not int or n < 1 for n in program_ids):
        raise ValueError("서로 다른 공고 ID 5개가 필요합니다.")
    if set(hashes) - set(EMAILS):
        raise ValueError("해시 파일에는 지정한 6개 계정만 허용합니다.")
    if any(not isinstance(h, str) or not re.fullmatch(r"\$2[aby]\$(?:1[0-6])\$[./A-Za-z0-9]{53}", h) for h in hashes.values()):
        raise ValueError("BCrypt 해시(cost 10–16)만 허용합니다. 평문 비밀번호를 넣지 마세요.")
    statements = [
        "SET NAMES utf8mb4;", "SET time_zone = '+09:00';", "SET @now := NOW(6);",
        f"SET @personal_demo_seed_lock_acquired := GET_LOCK('{LOCK_NAME}', 60);",
        "START TRANSACTION;", "SET @reset_personal_demo_data = 0;",
        "SET @demo_seed_target_emails = " + sql_text(",".join(EMAILS)) + ";",
    ]
    statements += [f"SET @p{i} = {n};" for i, n in enumerate(program_ids, 1)]
    statements += [f"SET @account_hash_{i} = {sql_text(hashes[email]) if email in hashes else 'NULL'};"
                   for i, email in enumerate(EMAILS)]
    statements.append((SEED_DIR / SEED_NAMES[0]).read_text(encoding="utf-8"))
    statements += [personal_body((SEED_DIR / name).read_text(encoding="utf-8")) for name in SEED_NAMES[1:]]
    statements += ["COMMIT;", f"DO RELEASE_LOCK('{LOCK_NAME}');", "SELECT 'GOVBIZ_PRODUCTION_DEMO_OK';"]
    return "\n".join(statements) + "\n"


def private_file(path, *, allow_root_reader=False):
    info = path.lstat()
    owner_matches = info.st_uid == os.geteuid() or (allow_root_reader and os.geteuid() == 0)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or not owner_matches:
        raise ValueError(f"소유자만 읽을 수 있는 일반 파일(chmod 600)이 필요합니다: {path}")


def connection_from_compose(env_file, compose_file):
    # The deployed env is normally owned by ssm-user (600); sudo may read it without changing ownership.
    private_file(env_file, allow_root_reader=True)
    result = subprocess.run(
        ["docker", "compose", "--env-file", str(env_file), "-f", str(compose_file), "config", "--format", "json"],
        env=PRIVATE_ENV, capture_output=True, text=True, timeout=60,
    )
    if result.returncode:
        raise ValueError("운영 Compose 해석 실패. 비밀정보 보호를 위해 원문 출력은 생략합니다.")
    env = json.loads(result.stdout)["services"]["core-service"]["environment"]
    url = urlsplit(env["SPRING_DATASOURCE_URL"].removeprefix("jdbc:"))
    if url.scheme != "mysql" or not url.hostname or not url.hostname.endswith(".rds.amazonaws.com"):
        raise ValueError("운영 RDS MySQL 엔드포인트만 허용합니다. 로컬 mysql은 사용할 수 없습니다.")
    database = url.path.removeprefix("/")
    if not re.fullmatch(r"[A-Za-z0-9_]+", database):
        raise ValueError("잘못된 데이터베이스 이름입니다.")
    return {"host": url.hostname, "port": url.port or 3306, "database": database,
            "user": env["SPRING_DATASOURCE_USERNAME"], "password": env["SPRING_DATASOURCE_PASSWORD"]}


def option_quote(value):
    value = str(value)
    if any(c in value for c in "\r\n\0"):
        raise ValueError("MySQL 접속 설정에 줄바꿈을 사용할 수 없습니다.")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


@contextmanager
def mysql_client(connection, ca_file):
    if not ca_file.is_file():
        raise ValueError("RDS CA PEM 파일이 없습니다. Java용 PKCS12 파일과 다릅니다.")
    with tempfile.TemporaryDirectory(prefix="govbiz-rds-seed-") as directory:
        options = Path(directory) / "client.cnf"
        with options.open("x", encoding="utf-8") as stream:
            os.chmod(options, 0o600)
            stream.write("[client]\n" + "".join(f"{k}={option_quote(v)}\n" for k, v in connection.items()))
        yield ["mysql", f"--defaults-file={options}", "--protocol=TCP",
               "--ssl-mode=VERIFY_IDENTITY", f"--ssl-ca={ca_file}", "--connect-timeout=10",
               "--default-character-set=utf8mb4", "--batch", "--skip-column-names", "--binary-mode"]


def query(command, sql):
    # No --force: the mysql batch client exits on the first error, rolling back the open transaction.
    options = next((item.split("=", 1)[1] for item in command if item.startswith("--defaults-file=")), None)
    if options is None:
        raise ValueError("소유자 전용 MySQL 옵션 파일이 필요합니다.")
    # Also isolate .mylogin.cnf on Ubuntu's 8.0 client, which lacks --no-login-paths.
    client_env = {**PRIVATE_ENV, "MYSQL_TEST_LOGIN_FILE": str(Path(options).with_name("unused-login.cnf"))}
    result = subprocess.run(command, input=sql, env=client_env, capture_output=True, text=True, timeout=180)
    if result.returncode:
        codes = re.findall(r"ERROR (\d+) \([0-9A-Z]+\)", result.stderr)
        raise ValueError("MySQL 실행 실패" + (" (" + ",".join(codes) + ")" if codes else "")
                         + ". 비밀값·SQL 원문은 출력하지 않습니다. 반영 여부를 재조회하세요.")
    return result.stdout


def preflight(command):
    emails = ",".join(sql_text(email) for email in EMAILS)
    rows = query(command, f"""
        SET SESSION TRANSACTION READ ONLY;
        START TRANSACTION;
        SELECT JSON_OBJECT('version', VERSION(), 'database', DATABASE(),
            'accounts', COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('email', email, 'role', role,
                'active', deleted_at IS NULL AND suspended_at IS NULL)) FROM account WHERE email IN ({emails})), JSON_ARRAY()),
            'program_ids', COALESCE((SELECT JSON_ARRAYAGG(id) FROM (
                SELECT id FROM support_program WHERE source_code='BIZINFO' AND is_source_present=TRUE
                AND application_end_date >= DATE_ADD(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+09:00')), INTERVAL 21 DAY)
                ORDER BY application_end_date DESC, id LIMIT 5) p), JSON_ARRAY()));
        ROLLBACK;
    """)
    result = json.loads(rows)
    if not result["version"].startswith("8.4."):
        raise ValueError("검증한 MySQL 8.4 환경이 아닙니다.")
    for account in result["accounts"]:
        expected_role = "ADMIN" if account["email"] == EMAILS[0] else "USER"
        if not account["active"] or account["role"] != expected_role:
            raise ValueError("대상 계정의 상태/권한이 예상과 다릅니다. 자동 변경하지 않습니다.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("/opt/govbiz/.env.production"))
    parser.add_argument("--compose-file", type=Path, default=Path("/opt/govbiz/infrastructure/compose.prod.yaml"))
    parser.add_argument("--ca-file", type=Path, default=Path("/opt/govbiz/certs/ap-southeast-2-bundle.pem"))
    parser.add_argument("--plan-file", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--account-hashes-file", type=Path)
    parser.add_argument("--confirm-new-admin", action="store_true")
    args = parser.parse_args()
    # Coordinate with the existing host deployment lock; never stop running services.
    with open("/var/lock/govbiz-backend-deploy.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("자동 배포 또는 다른 수동 작업이 실행 중입니다.") from None
        connection = connection_from_compose(args.env_file, args.compose_file)
        with mysql_client(connection, args.ca_file) as command:
            current = preflight(command)
            identity = {"host": connection["host"], "database": connection["database"],
                        "port": connection["port"], "emails": list(EMAILS), "fingerprint": seed_fingerprint()}
            if args.plan_file.exists():
                private_file(args.plan_file)
                plan = json.loads(args.plan_file.read_text(encoding="utf-8"))
                if any(plan.get(k) != v for k, v in identity.items()):
                    raise ValueError("계획의 DB 대상/코드 버전이 다릅니다. 기존 계획을 덮어쓰지 말고 새 계획을 검토하세요.")
            else:
                if args.apply:
                    raise ValueError("먼저 --apply 없이 읽기 전용 계획을 만드세요.")
                plan = {**identity, "program_ids": current["program_ids"]}
                build_sql(plan["program_ids"], {})  # Validate completeness before saving a plan.
                fd = os.open(args.plan_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(plan, stream, ensure_ascii=False, indent=2)
            missing = [email for email in EMAILS if email not in {a["email"] for a in current["accounts"]}]
            print(json.dumps({"database": connection["database"], "existing_accounts": current["accounts"],
                              "new_accounts": missing, "program_ids": plan["program_ids"],
                              "maximum_additions": {"companies": 6, "recruitments": 5, "proposals": 4,
                                                    "saved_programs": 20, "preparations": 12, "reviews": 12}},
                             ensure_ascii=False, indent=2), flush=True)
            if not args.apply:
                print("읽기 전용 계획 완료. 운영 데이터는 변경하지 않았습니다.")
                return
            if EMAILS[0] in missing and not args.confirm_new_admin:
                raise ValueError("새 관리자 생성은 별도 확인 후 --confirm-new-admin으로 승인해야 합니다.")
            hashes = {}
            if args.account_hashes_file:
                private_file(args.account_hashes_file)
                hashes = json.loads(args.account_hashes_file.read_text(encoding="utf-8"))
            if not isinstance(hashes, dict) or any(email not in hashes for email in missing):
                raise ValueError("새 계정마다 별도로 만든 BCrypt 해시가 필요합니다. 기본 비밀번호는 없습니다.")
            output = query(command, build_sql(plan["program_ids"], hashes))
            if "GOVBIZ_PRODUCTION_DEMO_OK" not in output.splitlines():
                raise ValueError("완료 표시를 확인하지 못했습니다. 자동 재시도하지 말고 데이터를 확인하세요.")
            print("GOVBIZ_PRODUCTION_DEMO_OK")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        # Do not echo configuration JSON, SQL, password hashes or command output in exceptions.
        if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError):
            print(str(error), file=sys.stderr)
        else:
            print("운영 시드 실행 실패. 파일·도구·연결 상태를 확인하세요.", file=sys.stderr)
        raise SystemExit(1)
