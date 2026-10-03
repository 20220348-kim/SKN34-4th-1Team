"""Run the disposable smoke's real Core against its copied DB, with fresh keys."""

import hashlib
import json
import os
import re
import secrets
from contextlib import contextmanager

from smoke_ops_bridge import execute


@contextmanager
def restored_core(nk, target, database_id, image, report):
    # Called only after smoke_ops_backup has established disposable ownership.
    from smoke_ops_backup import AUTH, DUMP, MYSQL, same_dump

    evidence = report["core_auth_restore"] = {
        "status": "FAIL",
        "scope": "disposable_core_database_and_fresh_session",
        "backup_verified": False,
        "personal_environment_verified": False,
        "original_signing_key_restored": False,
        "cleanup_complete": False,
    }
    if not re.fullmatch(r"[a-f0-9]{64}", database_id):
        raise ValueError("Invalid isolated Core database identity")
    deployment = json.loads(
        execute(nk + ["get", "deployment", "core-service", "-o", "json"])
    )
    containers = deployment["spec"]["template"]["spec"]["containers"]
    if len(containers) != 1 or containers[0]["image"] != image:
        raise ValueError("Core restore image differs from the deployed image")
    pod = json.loads(execute(nk + ["get", "pod", "core-mysql-0", "-o", "json"]))
    if pod["spec"]["containers"][0]["image"] != "mysql:8.4":
        raise ValueError("Core restore requires the MySQL 8.4 fixture")
    image_id = execute(
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"]
    ).strip()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Invalid Core restore image identity")
    execute(nk + ["scale", "deployment/core-service", "--replicas=0"])
    execute(
        nk
        + [
            "wait",
            "--for=delete",
            "pod",
            "-l",
            "app.kubernetes.io/name=core-service",
            "--timeout=120s",
        ]
    )
    if json.loads(
        execute(
            nk
            + ["get", "pods", "-l", "app.kubernetes.io/name=core-service", "-o", "json"]
        )
    )["items"]:
        raise ValueError("Core source writers remain running")
    source = nk + ["exec", "-i", "core-mysql-0", "-c", "mysql", "--"] + AUTH
    dump_command = DUMP[:-1] + ["govbiz_core"]
    dump = execute(source + dump_command)
    if not all(
        "CREATE TABLE `" + table + "`" in dump
        for table in ("account", "account_session", "flyway_schema_history")
    ):
        raise ValueError("Incomplete Core fixture dump")
    password = secrets.token_hex(32)
    execute(
        target + MYSQL,
        data=(
            "CREATE DATABASE govbiz_core CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
            "CREATE USER 'core_restore_fixture'@'%' IDENTIFIED BY '" + password + "';"
            "GRANT ALL ON govbiz_core.* TO 'core_restore_fixture'@'%';"
        ),
    )
    execute(target + MYSQL[:-1] + ["govbiz_core"], data=dump)
    same_dump(dump, execute(target + dump_command))
    env = {
        "SPRING_DATASOURCE_URL": "jdbc:mysql://127.0.0.1:3306/govbiz_core",
        "SPRING_DATASOURCE_USERNAME": "core_restore_fixture",
        "SPRING_DATASOURCE_PASSWORD": password,
        "SPRING_FLYWAY_ENABLED": "false",
        "ACCOUNT_JWT_SECRET": secrets.token_hex(48),
        "ACCOUNT_COOKIE_SECURE": "false",
        "ACCOUNT_DEV_LOGIN_ENABLED": "true",
        "ACCOUNT_DEV_LOGIN_MEMBER_EMAIL": "restore-member@example.invalid",
        "ACCOUNT_DEV_LOGIN_PASSWORD": secrets.token_hex(32),
        "BIZINFO_SYNC_ENABLED": "false",
        "SUPPORT_PROGRAM_INDEX_ENABLED": "false",
        "ACCOUNT_OAUTH_UNLINK_ENABLED": "false",
        "APPLICATION_DOCUMENT_JOBS_ENABLED": "false",
        "SERVER_ADDRESS": "127.0.0.1",
        "APP_CORS_ALLOWED_ORIGIN": "http://127.0.0.1:8080",
    }
    identity = None
    try:
        identity = execute(
            [
                "docker",
                "create",
                "--network",
                "container:" + database_id,
                "--read-only",
                "--user",
                "10001:10001",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "512m",
                "--pids-limit",
                "128",
                "--tmpfs",
                "/tmp:rw,nosuid,size=64m",
                *[part for key in env for part in ("--env", key)],
                "--entrypoint",
                "java",
                image_id,
                "-Xmx256m",
                "-XX:ActiveProcessorCount=2",
                "-jar",
                "/app/application.jar",
            ],
            env={**os.environ, **env},
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid Core restore container identity")
        execute(["docker", "start", identity])
        yield
        same_dump(dump, execute(source + dump_command))
        evidence.update(
            image_id=image_id,
            source_preserved=True,
            schema_and_rows_match_before_login=True,
            dump_sha256=hashlib.sha256(dump.encode("utf-8")).hexdigest(),
            automatic_migrations=False,
            network_isolated=True,
        )
    finally:
        if identity is not None:
            try:
                execute(["docker", "stop", "--time", "30", identity], timeout=45)
                state = json.loads(
                    execute(
                        ["docker", "inspect", "--format", "{{json .State}}", identity]
                    )
                )
                if (
                    state["Running"]
                    or state["OOMKilled"]
                    or state["ExitCode"] not in (0, 143)
                ):
                    raise ValueError("Restored Core did not stop cleanly")
            finally:
                execute(["docker", "rm", "--force", "--volumes", identity], timeout=30)
                evidence["cleanup_complete"] = True
    evidence["status"] = "PASS"
