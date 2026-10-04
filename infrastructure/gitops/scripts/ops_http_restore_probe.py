"""Exercise real Ops/report HTTP against disposable restored DB and result files."""

import base64
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

BROWSER_ORIGIN = "http://127.0.0.1:5173"


def copy_evidence(target):
    """Copy only versioned catalog inputs, never the surrounding evaluation tree."""
    repository = Path(__file__).resolve().parents[3]
    source = repository / "evaluation/support-program-evidence"
    catalog = json.loads(
        (
            repository / "backend/ops-service/apps/evaluations/capture_catalog.json"
        ).read_text(encoding="utf-8")
    )
    names = {
        name
        for dataset in catalog
        for name in [
            dataset["fixture"],
            *[item["path"] for item in dataset["captures"]],
        ]
    }
    total = 0
    for name in sorted(names):
        path = source / name
        if (
            not name
            or "\\" in name
            or Path(name).is_absolute()
            or any(part in {"", ".", ".."} for part in name.split("/"))
            or not path.resolve(strict=True).is_relative_to(source.resolve())
            or path.is_symlink()
        ):
            raise ValueError("Invalid restored evidence path")
        with path.open("rb") as stream:
            raw = stream.read(8 * 1024 * 1024 + 1)
        total += len(raw)
        if len(raw) > 8 * 1024 * 1024 or total > 64 * 1024 * 1024:
            raise ValueError("Restored evidence exceeds the size limit")
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(raw)
    # TemporaryDirectory is 0700 on Linux; the container's UID 10001 must read it.
    for path in [target, *target.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)


def verify_evidence(root):
    """The restored image, not the host checkout, pins accepted input bytes."""
    from apps.evaluations.artifact_files import read_file
    from apps.evaluations.catalog import DATASETS
    from apps.evaluations.execution_spec import read_release

    release = read_release()
    for dataset in DATASETS.values():
        pinned = release["datasets"][dataset["id"]]
        files = [(dataset["fixture"], pinned["fixture_sha256"])] + [
            (item["path"], pinned["captures"][item["id"]])
            for item in dataset["captures"]
        ]
        for name, expected in files:
            if hashlib.sha256(read_file(root, name)).hexdigest() != expected:
                raise ValueError("Restored evidence differs from the execution release")


def response(path, token=None, *, port=8000, payload=None, method="GET", headers=None):
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    client = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(
        f"http://127.0.0.1:{port}" + path,
        headers={
            "Content-Type": "application/json",
            **({"Origin": BROWSER_ORIGIN} if port == 8080 and method == "POST" else {}),
            **({} if token is None else {"Cookie": "govbiz_session=" + token}),
            **(headers or {}),
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


def browser_requests(principal, routes):
    """Relay only this restored fixture's HTTP routes over its attached stdin/stdout."""
    print(
        json.dumps({"phase": "browser_ready", "email": principal["email"]}), flush=True
    )
    while True:
        line = sys.stdin.readline(32769)
        if not line or len(line) > 32768 or not line.endswith("\n"):
            raise ValueError("Restored browser transport input is incomplete")
        value = json.loads(line)
        if value == {"phase": "browser_done"}:
            return
        if not isinstance(value, dict) or set(value) != {
            "port",
            "path",
            "method",
            "cookie",
            "origin",
            "payload",
        }:
            raise ValueError("Unexpected restored browser request")
        port, route, method = value["port"], value["path"], value["method"]
        core_read = (
            port == 8080 and method == "GET" and route == "/api/v1/admin/session"
        )
        core_write = (
            port == 8080
            and method == "POST"
            and route in {"/api/v1/auth/login", "/api/v1/auth/logout"}
        )
        ops_read = port == 8000 and method == "GET" and route in routes
        if type(port) is not int or not (core_read or core_write or ops_read):
            raise ValueError("Restored browser route or method is forbidden")
        cookie, origin, payload = value["cookie"], value["origin"], value["payload"]
        if (
            not isinstance(cookie, str)
            or len(cookie) > 8192
            or any(c in cookie for c in "\r\n")
        ):
            raise ValueError("Invalid restored browser cookie header")
        if origin not in (None, BROWSER_ORIGIN) or (
            core_write and origin != BROWSER_ORIGIN
        ):
            raise ValueError("Unexpected restored browser origin")
        if route == "/api/v1/auth/login":
            if (
                not isinstance(payload, dict)
                or set(payload) != {"email", "password", "rememberMe"}
                or payload["email"] != principal["email"]
                or not isinstance(payload["password"], str)
                or not 1 <= len(payload["password"]) <= 4096
                or payload["rememberMe"] is not False
            ):
                raise ValueError("Invalid restored browser login request")
        elif payload is not None:
            raise ValueError("Unexpected restored browser request body")
        status, headers, raw = response(
            route,
            port=port,
            method=method,
            payload=payload,
            headers={
                "Host": "127.0.0.1:5173" if port == 8000 else "127.0.0.1:8080",
                **({"Cookie": cookie} if cookie else {}),
                **({"Origin": origin} if origin else {}),
            },
        )
        forwarded = {
            key.lower(): headers[key]
            for key in ("Content-Type", "Cache-Control", "Content-Security-Policy")
            if key in headers
        }
        cookies = headers.get_all("Set-Cookie", [])
        if cookies:
            forwarded["set-cookie"] = cookies
        print(
            json.dumps(
                {
                    "phase": "browser_response",
                    "status": status,
                    "headers": forwarded,
                    "body": base64.b64encode(raw).decode("ascii"),
                }
            ),
            flush=True,
        )


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


def check_management(expected, principal, token, member_token, total_runs):
    from apps.evaluations.execution_spec import digest
    from ops_database_restore_probe import verify_response

    if type(total_runs) is not int or not len(expected) <= total_runs <= 1000:
        raise ValueError("Unexpected restored management row count")
    snapshots = {}

    def get(route):
        for cookie, code in (("invalid-fixture", 401), (member_token, 403)):
            if response(route, cookie)[0] != code:
                raise ValueError("Restored management accepted an unauthorized read")
        if route != "/api/v1/ops/session" and response(route)[0] != 401:
            raise ValueError("Restored management accepted an anonymous read")
        status, headers, raw = response(route, token)
        if (
            status != 200
            or "no-store" not in headers.get("Cache-Control", "")
            or not headers.get("Content-Type", "").startswith("application/json")
        ):
            raise ValueError(
                f"Restored management JSON is unavailable or cacheable: {route} (HTTP {status})"
            )
        value = json.loads(raw)
        snapshots[route] = value
        return value

    status, _, raw = response("/api/v1/ops/session")
    anonymous = json.loads(raw)
    if (
        status != 200
        or anonymous.get("user") is not None
        or anonymous.get("datasets") != []
    ):
        raise ValueError("Restored management disclosed an anonymous session")
    session = get("/api/v1/ops/session")
    if (
        session.get("user")
        != {"id": "core:" + str(principal["accountId"]), "username": principal["email"]}
        or not isinstance(session.get("csrf_token"), str)
        or not session["csrf_token"]
        or not session.get("datasets")
        or session.get("live_enabled") is not False
        or session.get("rag_live_enabled") is not False
    ):
        raise ValueError("Restored management session differs")
    # The consumer only needs the field's shape; never export a live CSRF token.
    session["csrf_token"] = "redacted-restore-csrf"
    rows = {}
    pages = (total_runs + 24) // 25
    for page in range(1, pages + 1):
        result = get(f"/api/v1/ops/evaluations?page={page}")
        following = (
            f"http://127.0.0.1:8000/api/v1/ops/evaluations?page={page + 1}"
            if page < pages
            else None
        )
        if (
            type(result.get("count")) is not int
            or result["count"] != total_runs
            or result.get("next") != following
            or not result.get("results")
        ):
            raise ValueError("Restored management pagination differs")
        for row in result["results"]:
            if row["id"] in rows:
                raise ValueError("Restored management repeated an evaluation")
            rows[row["id"]] = row
    if len(rows) != total_runs or not set(expected).issubset(rows):
        raise ValueError("Restored management omitted evaluations")
    budget = get("/api/v1/ops/budget/reservations?page=1")
    schedules = get("/api/v1/ops/schedules?page=1")
    if schedules.get("enabled") is not False or not isinstance(
        schedules.get("results"), list
    ):
        raise ValueError("Restored management schedules must remain disabled")
    if (
        not isinstance(budget.get("results"), list)
        or budget.get("summary", {}).get("state") != "consistent"
    ):
        raise ValueError("Restored management budget is inconsistent")
    for request, row in expected.items():
        verify_response(rows[request], request, row, digest)
        route = "/api/v1/ops/evaluations/" + request
        detail = get(route)
        if {
            key: value for key, value in detail.items() if key != "postprocessing"
        } != rows[request] or detail.get("postprocessing", {}).get(
            "can_recover"
        ) is not False:
            raise ValueError("Restored management detail differs from its listing")
        if detail["report_url"] != route + "/report":
            raise ValueError("Restored management report route differs")
        run_budget = get(route + "/budget")
        if (
            run_budget.get("state") != "not_applicable"
            or run_budget.get("reservation") is not None
            or run_budget.get("calls") != []
        ):
            raise ValueError("Restored replay unexpectedly has a paid budget")
        if detail.get("evaluation_scope") == "fixed-answer-context-only":
            review = get(route + "/review")
            material = review.get("material")
            if (
                not isinstance(material, dict)
                or review.get("material_error") != ""
                or review.get("quality", {}).get("blocked_reason") != ""
                or material.get("fixture_sha256")
                != detail["execution_spec"]["dataset"]["fixture_sha256"]
                or [case["case_id"] for case in material.get("cases", [])]
                != detail["execution_spec"]["dataset"]["case_ids"]
            ):
                raise ValueError("Restored management review material is unavailable")
        elif detail.get("evaluation_scope") == "source-chunks-retrieval-answer":
            review = get(route + "/rag-reviews")
            material = review.get("material")
            spec = detail["execution_spec"]
            if (
                not isinstance(material, dict)
                or material.get("evaluation_scope") != detail["evaluation_scope"]
                or material.get("fixture_sha256") != spec["dataset"]["fixture_sha256"]
                or material.get("candidate_capture_sha256") != spec["candidate_sha256"]
                or material.get("reference_capture_sha256") != spec["reference_sha256"]
                or [case["case_id"] for case in material.get("cases", [])]
                != spec["dataset"]["case_ids"]
                or material.get("material_sha256")
                != digest({k: v for k, v in material.items() if k != "material_sha256"})
            ):
                raise ValueError("Restored RAG review material differs from its inputs")
    return {
        "evidence": {
            "status": "PASS",
            "session_verified": True,
            "listed_run_count": total_runs,
            "matched_details": len(expected),
            "pagination_complete": True,
            "budget_reads_verified": True,
            "unauthorized_reads_rejected": True,
            "browser_rendered": False,
        },
        "responses": snapshots,
    }


def check_http(expected, progress=lambda _: None):
    from ops_volume_restore_probe import expected_runs, tree

    progress("SETUP")
    expected_runs(expected)
    if os.getuid() != 10001 or os.getgid() != 10001:
        raise ValueError("Restored Ops HTTP requires runtime UID/GID 10001")
    before = tree(Path("/restore"))
    evidence_before = tree(Path("/evidence"))
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
        verify_evidence(Path("/evidence"))
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
        total_runs = EvaluationRun.objects.count()
        connection.close()
        progress("CORE_LOGIN")
        token, member_token = core_login(principal, core_password)
        servers = []
        try:
            progress("SERVERS")
            for app, port, server_env in (
                (
                    "apps.evaluations.artifact_server:create_app()",
                    "8010",
                    {
                        "PATH": path,
                        "HOME": home,
                        "PYTHONDONTWRITEBYTECODE": "1",
                        "LLMOPS_RESULTS_DIR": "/restore",
                        "LLMOPS_EVIDENCE_DIR": "/evidence",
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
            progress("MANAGEMENT")
            management = check_management(
                expected, principal, token, member_token, total_runs
            )
            progress("REPORTS")
            reports = {}
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
                    or not headers.get("Content-Type", "").startswith("text/html")
                ):
                    raise ValueError("Restored Ops report or response headers differ")
                reports[route] = {
                    "body": raw.decode("utf-8"),
                    "headers": {
                        key.lower(): headers[key]
                        for key in (
                            "Content-Type",
                            "Cache-Control",
                            "Content-Security-Policy",
                        )
                    },
                }
            progress("BROWSER")
            browser_requests(principal, set(management["responses"]) | set(reports))
            progress("REVOCATION")
            # Revoke a real persisted session, then prove Ops cannot reuse it.
            if (
                response("/api/v1/auth/logout", token, port=8080, method="POST")[0]
                != 204
            ):
                raise ValueError("Restored Core logout failed")
            if response(route, token)[0] != 401:
                raise ValueError("Restored Ops accepted a revoked Core session")
            progress("ARTIFACT_OUTAGE")
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
    progress("FILES")
    if tree(Path("/restore")) != before or tree(Path("/evidence")) != evidence_before:
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
        "management_http": management["evidence"],
        "management_responses": management["responses"],
        "report_responses": reports,
    }


def verify(image, volume, expected, database):
    import ops_database_restore_probe
    import ops_volume_restore_probe
    from smoke_ops_bridge import execute

    if not re.fullmatch(r"[a-f0-9]{64}", database["id"]) or image != database["image"]:
        raise ValueError("Unexpected restored Ops database or image")
    identity = None
    evidence = tempfile.TemporaryDirectory(prefix="ops-restore-evidence-")
    try:
        copy_evidence(Path(evidence.name))
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
                "--mount",
                "type=bind,source=" + evidence.name + ",target=/evidence,readonly",
                "--env",
                "DB_PASSWORD",
                "--env",
                "CORE_LOGIN_PASSWORD",
                "--entrypoint",
                "python",
                image,
                "-B",
                "-u",
                "-c",
                "import sys,json; exec(json.loads(sys.stdin.readline()))",
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
            + "module=types.ModuleType('ops_database_restore_probe')\nexec("
            + repr(
                Path(ops_database_restore_probe.__file__).read_text(encoding="utf-8")
            )
            + ", module.__dict__)\nsys.modules[module.__name__]=module\n"
            + Path(__file__).read_text(encoding="utf-8")
            + "\ndef stage(value): print(json.dumps({'phase':'progress','step':value}),flush=True)\n"
            + "\nprint(json.dumps({'phase':'complete','result':check_http("
            + repr(expected)
            + ",stage)}),flush=True)\n"
        )
        result = json.loads(
            execute(
                ["node", Path(__file__).with_name("ops_restore_live_browser.mjs")],
                data=json.dumps(
                    {
                        "identity": identity,
                        "program": program,
                        "password": database["core_password"],
                        "expected": expected,
                    }
                ),
                timeout=360,
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
        management = result.get("management_http", {})
        if (
            management.get("status") != "PASS"
            or type(management.get("listed_run_count")) is not int
            or not len(expected) <= management["listed_run_count"] <= 1000
            or type(management.get("matched_details")) is not int
            or management["matched_details"] != len(expected)
            or management.get("browser_rendered") is not False
            or any(
                management.get(key) is not True
                for key in (
                    "session_verified",
                    "pagination_complete",
                    "budget_reads_verified",
                    "unauthorized_reads_rejected",
                )
            )
        ):
            raise ValueError("Incomplete restored management HTTP evidence")
        browser = result.get("browser_login", {})
        version = browser.get("browser_version") if isinstance(browser, dict) else None
        if not isinstance(version, str) or not re.fullmatch(
            r"[0-9]+(?:\.[0-9]+){3}", version
        ):
            raise ValueError("Incomplete restored live browser version")
        required_browser = {
            "status": "PASS",
            "response_source": "restored_core_ops_http",
            "transport": "docker_attached_stdio",
            "browser_version": version,
            "password_login_verified": True,
            "httponly_cookie_received": True,
            "core_ops_identity_verified": True,
            "reload_verified": True,
            "listed_run_count": management["listed_run_count"],
            "pages_verified": (management["listed_run_count"] + 24) // 25,
            "pagination_complete": True,
            "details_verified": len(expected),
            "reports_verified": len(expected),
            "logout_verified": True,
            "unauthorized_after_logout": True,
            "revoked_session_rejected": True,
            "browser_closed": True,
            "proxy_stopped": True,
            "helper_exited": True,
        }
        if json.dumps(browser, sort_keys=True) != json.dumps(
            required_browser, sort_keys=True
        ):
            raise ValueError("Incomplete restored live browser evidence")
        snapshots = result.pop("management_responses")
        reports = result.pop("report_responses")
        with tempfile.TemporaryDirectory(prefix="ops-restore-contract-") as folder:
            contract = Path(folder) / "responses.json"
            contract.write_text(
                json.dumps(
                    {
                        "responses": snapshots,
                        "reports": reports,
                        "expected": expected,
                        "total_runs": management["listed_run_count"],
                    }
                ),
                encoding="utf-8",
            )
            result["management_web_contract"] = json.loads(
                execute(
                    [
                        "node",
                        "--experimental-transform-types",
                        Path(__file__).with_name("check_ops_restore_ui.mjs"),
                        contract,
                    ],
                    timeout=180,
                )
            )
        web = result["management_web_contract"]
        browser = web.get("browser_ui", {}) if isinstance(web, dict) else {}
        version = browser.get("browser_version") if isinstance(browser, dict) else None
        if not isinstance(version, str) or not re.fullmatch(
            r"[0-9]+(?:\.[0-9]+){3}", version
        ):
            raise ValueError("Incomplete restored management browser version")
        expected_web = {
            "status": "PASS",
            "matched_details": len(expected),
            "listed_run_count": management["listed_run_count"],
            "browser_rendered": True,
            "browser_ui": {
                "status": "PASS",
                "response_source": "captured_restore_http",
                "browser_version": version,
                "listed_run_count": management["listed_run_count"],
                "pages_verified": (management["listed_run_count"] + 24) // 25,
                "budget_view_verified": True,
                "details_verified": len(expected),
                "report_documents_verified": len(expected),
                "report_sandbox_verified": True,
                "report_denials_verified": len(expected),
                "denied_view_verified": True,
                "browser_rendered": True,
                "browser_closed": True,
            },
            "proxy_http": {
                "status": "PASS",
                "mode": "portfolio",
                "response_source": "captured_restore_http",
                "routes_verified": True,
                "credentials_forwarded": True,
                "unauthorized_status_preserved": True,
                "outage_rejected": True,
                "document_served": True,
                "report_documents_verified": len(expected),
                "servers_stopped": True,
                "browser_rendered": False,
            },
        }
        # JSON distinguishes booleans from integers, unlike Python dict equality.
        if json.dumps(web, sort_keys=True) != json.dumps(expected_web, sort_keys=True):
            raise ValueError("Incomplete restored management web contract evidence")
    finally:
        try:
            if identity is not None:
                execute(["docker", "rm", "--force", "--volumes", identity], timeout=30)
        finally:
            evidence.cleanup()
    return {**result, "cleanup_complete": True}
