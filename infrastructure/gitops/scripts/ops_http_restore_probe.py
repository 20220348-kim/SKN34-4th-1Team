"""Exercise real Ops/report HTTP against disposable restored DB and result files."""

import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


def response(path, token=None, *, port=8000, payload=None, method="GET"):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    client = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(
        f"http://127.0.0.1:{port}" + path,
        headers={
            "Content-Type": "application/json",
            **(
                {"Origin": "http://127.0.0.1:8080"}
                if port == 8080 and method == "POST"
                else {}
            ),
            **({} if token is None else {"Cookie": "govbiz_session=" + token}),
        },
        data=None if payload is None else json.dumps(payload).encode(),
        method=method,
    )
    try:
        reply = client.open(request, timeout=5)
    except HTTPError as error:
        reply = error
    with reply:
        raw = reply.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024 or (
            port == 8000 and reply.headers.get("Content-Length") != str(len(raw))
        ):
            raise ValueError("Unexpected restored Ops response size")
        return reply.status, reply.headers, raw


def core_login(principal, password):
    """Log into the actual Core image; never synthesize or sign a session token."""
    deadline = time.monotonic() + 90
    while True:
        try:
            if response("/api/v1/health", port=8080)[0] != 200:
                raise ValueError("Restored Core is not healthy")
            break
        except (URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise ValueError("Restored Core startup timed out") from None
            time.sleep(1)
    tokens = []
    for route, payload in (
        ("/login", {"email": principal["email"], "password": password}),
        ("/dev-login", {"role": "USER"}),
    ):
        status, headers, raw = response(
            "/api/v1/auth" + route, port=8080, payload=payload, method="POST"
        )
        cookies = SimpleCookie()
        cookies.load(headers.get("Set-Cookie", ""))
        cookie = cookies.get("govbiz_session")
        if (
            status != 200
            or cookie is None
            or not cookie["httponly"]
            or not re.fullmatch(r"[A-Za-z0-9_.-]{1,4096}", cookie.value)
        ):
            raise ValueError("Restored Core did not issue a login session")
        tokens.append(cookie.value)
    status, _, raw = response("/api/v1/admin/session", tokens[0], port=8080)
    if status != 200 or json.loads(raw) != principal:
        raise ValueError("Restored Core administrator differs from the Ops requester")
    if (
        tokens[0] == tokens[1]
        or response("/api/v1/admin/session", tokens[1], port=8080)[0] != 403
    ):
        raise ValueError("Restored Core did not reject the member session")
    return tokens


def stop(server):
    server.terminate()
    try:
        code = server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)
        raise ValueError("Restored HTTP server shutdown timed out") from None
    if code not in (0, -15, 143):
        raise ValueError("Restored HTTP server did not exit cleanly")


def check_http(expected):
    from ops_volume_restore_probe import expected_runs, tree

    expected_runs(expected)
    if os.getuid() != 10001 or os.getgid() != 10001:
        raise ValueError("Restored Ops HTTP requires runtime UID/GID 10001")
    before = tree(Path("/restore"))
    password, path = os.environ["DB_PASSWORD"], os.environ["PATH"]
    core_password = os.environ["CORE_LOGIN_PASSWORD"]
    artifact_token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="ops-http-restore-") as home:
        empty = Path(home) / "empty"
        empty.mkdir()
        env = {
            "PATH": path,
            "HOME": home,
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SETTINGS_MODULE": "config.settings",
            "DJANGO_SECRET_KEY": secrets.token_hex(48),
            "DJANGO_ALLOWED_HOSTS": "127.0.0.1",
            "DB_HOST": "127.0.0.1",
            "DB_PORT": "3306",
            "DB_NAME": "govbiz_ops",
            "DB_USER": "ops_restore_reader",
            "DB_PASSWORD": password,
            "LLMOPS_LIVE_ENABLED": "false",
            "LLMOPS_RAG_LIVE_ENABLED": "false",
            "LLMOPS_ARTIFACT_URL": "http://127.0.0.1:8010",
            "LLMOPS_ARTIFACT_TOKEN": artifact_token,
            "LLMOPS_RESULTS_DIR": str(empty),
            "LLMOPS_EVIDENCE_DIR": str(empty),
            "CORE_API_URL": "http://127.0.0.1:8080",
        }
        os.environ.clear()
        os.environ.update(env)
        import django

        django.setup()
        from apps.evaluations.models import EvaluationRun
        from django.db import connection

        user = (
            EvaluationRun.objects.select_related("requested_by")
            .get(pk=next(iter(expected)))
            .requested_by
        )
        if not re.fullmatch(r"core:[1-9][0-9]*", user.username) or not user.email:
            raise ValueError("Restored Core requester identity is missing")
        principal = {
            "accountId": int(user.username[5:]),
            "email": user.email,
            "role": "ADMIN",
        }
        connection.close()
        token, member_token = core_login(principal, core_password)
        servers = []
        try:
            for app, port, server_env in (
                (
                    "apps.evaluations.artifact_server:create_app()",
                    "8010",
                    {
                        "PATH": path,
                        "HOME": home,
                        "PYTHONDONTWRITEBYTECODE": "1",
                        "LLMOPS_RESULTS_DIR": "/restore",
                        "LLMOPS_EVIDENCE_DIR": str(empty),
                        "LLMOPS_ARTIFACT_TOKEN": artifact_token,
                    },
                ),
                ("config.wsgi:application", "8000", env),
            ):
                servers.append(
                    subprocess.Popen(
                        [
                            sys.executable,
                            "-B",
                            "-m",
                            "gunicorn",
                            app,
                            "--bind",
                            "127.0.0.1:" + port,
                            "--workers",
                            "1",
                            "--timeout",
                            "15",
                            "--graceful-timeout",
                            "5",
                            "--worker-tmp-dir",
                            home,
                        ],
                        env=server_env,
                        cwd="/app",
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                )
            deadline = time.monotonic() + 30
            while True:
                if any(server.poll() is not None for server in servers):
                    raise ValueError("Restored HTTP server exited before verification")
                try:
                    status, _, raw = response("/api/v1/health/ready")
                    if status != 200 or json.loads(raw) != {
                        "status": "UP",
                        "checks": {"database": "UP", "schema": "UP"},
                    }:
                        raise ValueError("Restored Ops HTTP is not ready")
                    # Artifact startup can lag Ops startup; wait for its own TCP readiness.
                    client = build_opener(ProxyHandler({}))
                    with client.open(
                        Request(
                            "http://127.0.0.1:8010/v1/status",
                            headers={"Authorization": "Bearer " + artifact_token},
                        ),
                        timeout=3,
                    ) as reply:
                        if json.load(reply) != {
                            "schema_version": 1,
                            "results_readable": True,
                        }:
                            raise ValueError("Restored artifact HTTP is not ready")
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise ValueError("Restored HTTP startup timed out") from None
                    time.sleep(1)
            for request, row in expected.items():
                route = "/api/v1/ops/evaluations/" + request + "/report"
                for cookie, code in (
                    (None, 401),
                    ("invalid-fixture", 401),
                    (member_token, 403),
                ):
                    if response(route, cookie)[0] != code:
                        raise ValueError(
                            "Restored Ops accepted an unauthorized report request"
                        )
                status, headers, raw = response(route, token)
                if (
                    status != 200
                    or hashlib.sha256(raw).hexdigest() != row["report_sha256"]
                    or headers.get("Cache-Control")
                    != "private, no-store, max-age=0, no-cache, must-revalidate"
                    or "sandbox allow-scripts;"
                    not in headers.get("Content-Security-Policy", "")
                ):
                    raise ValueError("Restored Ops report or response headers differ")
            # Revoke a real persisted session, then prove Ops cannot reuse it.
            if (
                response("/api/v1/auth/logout", token, port=8080, method="POST")[0]
                != 204
            ):
                raise ValueError("Restored Core logout failed")
            if response(route, token)[0] != 401:
                raise ValueError("Restored Ops accepted a revoked Core session")
            token, _ = core_login(principal, core_password)
            stop(servers.pop(0))
            if response(route, token)[0] != 404:
                raise ValueError("Restored Ops concealed the artifact server outage")
        finally:
            errors = []
            for server in reversed(servers):
                try:
                    stop(server)
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    errors.append(error)
            if errors:
                raise errors[0]
    if tree(Path("/restore")) != before:
        raise ValueError("Restored Ops HTTP changed result files")
    return {
        "status": "PASS",
        "matched_reports": len(expected),
        "readiness": "UP",
        "auth_contract": "restored_core_password_login",
        "core_admin_auth_verified": True,
        "unauthorized_rejected": True,
        "artifact_outage_rejected": True,
        "revoked_session_rejected": True,
        "files_unchanged": True,
        "servers_stopped": True,
        "runtime_uid": 10001,
        "model_api_calls": 0,
    }


def verify(image, volume, expected, database):
    import ops_volume_restore_probe
    from smoke_ops_bridge import execute

    if not re.fullmatch(r"[a-f0-9]{64}", database["id"]) or image != database["image"]:
        raise ValueError("Unexpected restored Ops database or image")
    identity = None
    try:
        identity = execute(
            [
                "docker",
                "create",
                "--interactive",
                "--network",
                "container:" + database["id"],
                "--read-only",
                "--user",
                "10001:10001",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "384m",
                "--pids-limit",
                "64",
                "--tmpfs",
                "/tmp:rw,nosuid,size=32m",
                "--mount",
                "type=volume,source=" + volume + ",target=/restore,readonly",
                "--env",
                "DB_PASSWORD",
                "--env",
                "CORE_LOGIN_PASSWORD",
                "--entrypoint",
                "python",
                image,
                "-B",
                "-",
            ],
            env={
                **os.environ,
                "DB_PASSWORD": database["password"],
                "CORE_LOGIN_PASSWORD": database["core_password"],
            },
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            identity = None
            raise ValueError("Invalid restored Ops HTTP helper identity")
        program = (
            "import sys,types\nmodule=types.ModuleType('ops_volume_restore_probe')\n"
            + "exec("
            + repr(Path(ops_volume_restore_probe.__file__).read_text(encoding="utf-8"))
            + ", module.__dict__)\n"
            + "sys.modules[module.__name__]=module\n"
            + Path(__file__).read_text(encoding="utf-8")
            + "\nprint(json.dumps(check_http("
            + repr(expected)
            + ")))\n"
        )
        result = json.loads(
            execute(
                ["docker", "start", "--attach", "--interactive", identity],
                data=program,
                timeout=240,
            )
        )
        required = {
            "status": "PASS",
            "matched_reports": len(expected),
            "readiness": "UP",
            "auth_contract": "restored_core_password_login",
            "core_admin_auth_verified": True,
            "unauthorized_rejected": True,
            "artifact_outage_rejected": True,
            "revoked_session_rejected": True,
            "files_unchanged": True,
            "servers_stopped": True,
            "runtime_uid": 10001,
            "model_api_calls": 0,
        }
        if not isinstance(result, dict) or any(
            type(result.get(key)) is not type(value) or result[key] != value
            for key, value in required.items()
        ):
            raise ValueError("Incomplete restored Ops HTTP evidence")
    finally:
        if identity is not None:
            execute(["docker", "rm", "--force", "--volumes", identity], timeout=30)
    return {**result, "cleanup_complete": True}
