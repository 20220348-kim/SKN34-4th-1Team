#!/usr/bin/env python3
"""Verify the catalog boundary using disposable MySQL and local HTTP fixtures.

No developer .env files, existing databases, public source APIs or paid model APIs
are used. --config-only validates the Compose and source boundaries without Docker
Engine access; the default also builds and exercises the separated services.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infrastructure"
SOURCES = ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")
TOKEN = "catalog-separation-fixture-token-never-use-in-production"
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def call_json(url, token=None):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token is not None:
        request.add_header("Authorization", "Bearer " + token)
    try:
        with LOCAL_HTTP.open(request, timeout=75) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            return error.code, json.loads(body)
        except json.JSONDecodeError:
            return error.code, None


def wait_for(label, probe, timeout):
    deadline = time.monotonic() + timeout
    last_error = "condition not ready"
    while time.monotonic() < deadline:
        try:
            result = probe()
            if result:
                print("PASS: " + label, flush=True)
                return result
        except (OSError, ValueError, AssertionError) as error:
            last_error = str(error)
        time.sleep(2)
    raise AssertionError(label + " timed out: " + last_error)


def fixture_env():
    values = {
        "OPENAI_API_KEY": "catalog-verification-key-never-sent",
        "OPENAI_BASE_URL": "http://openai-stub:8002/v1",
        "OPENAI_EMBEDDING_MODEL": "text-embedding-3-small",
        "OPENAI_EMBEDDING_DIMENSIONS": "1536",
        "CATALOG_INTERNAL_TOKEN": TOKEN,
        "CATALOG_PROJECTION_INITIAL_DELAY": "PT0S",
        "CATALOG_PROJECTION_FIXED_DELAY": "PT2S",
        "MYSQL_DATABASE": "govbiz_core_fixture",
        "MYSQL_USER": "core_fixture",
        "MYSQL_PASSWORD": "core-fixture-password",
        "MYSQL_ROOT_PASSWORD": "core-root-fixture-password",
        "CATALOG_MYSQL_DATABASE": "govbiz_catalog_fixture",
        "CATALOG_MYSQL_USER": "catalog_fixture",
        "CATALOG_MYSQL_PASSWORD": "catalog-fixture-password",
        "CATALOG_MYSQL_ROOT_PASSWORD": "catalog-root-fixture-password",
        "BIZINFO_API_BASE_URL": "http://bizinfo-stub:8001",
        "DATA_GO_KR_SERVICE_KEY": "compose%2Bverification%2Fkey%3D",
        "KSTARTUP_API_BASE_URL": "http://kstartup-stub:8003",
        "KSTARTUP_API_KEY": "compose%2Bstartup%2Fverification%3D",
        "KSTARTUP_SYNC_SCOPE": "RECENT_YEAR",
        "MSIT_API_BASE_URL": "http://public-notices-stub:8004",
        "MSIT_API_KEY": "compose%2Bnotice%2Fverification%3D",
        "CNTRADE_NOTICE_API_BASE_URL": "http://public-notices-stub:8004",
        "CNTRADE_NOTICE_API_KEY": "compose%2Bnotice%2Fverification%3D",
        "ELASTICSEARCH_API_KEY": "",
        "ELASTICSEARCH_INDEX_NAME": "govbiz-support-program-lexical-v2",
        "SUPPORT_PROGRAM_INDEX_ENABLED": "true",
        "SUPPORT_PROGRAM_INDEX_INITIAL_DELAY": "PT0S",
        "SUPPORT_PROGRAM_INDEX_FIXED_DELAY": "PT2S",
        "DEMO_SEED_ENABLED": "false",
        "DEMO_SEED_FORCE": "false",
        "DAILY_REPORT_ENABLED": "false",
        "DAILY_REPORT_MAIL_ENABLED": "false",
        "DAILY_REPORT_QUEUE_ENABLED": "false",
        "DAILY_REPORT_DELIVERY_QUEUE_ENABLED": "false",
        "ACCOUNT_PASSWORD_RESET_MAIL_ENABLED": "false",
        "ACCOUNT_OAUTH_UNLINK_ENABLED": "false",
        "ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED": "false",
        "COMBINATION_REVIEW_QUEUE_ENABLED": "false",
        "APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED": "false",
        "APPLICATION_FORM_ANALYSIS_ENABLED": "false",
        "ASSISTANT_AGENT_ENABLED": "false",
        "ASSISTANT_PREFETCH_QUEUE_ENABLED": "false",
        "RABBITMQ_USERNAME": "catalog-fixture",
        "RABBITMQ_PASSWORD": "catalog-rabbit-fixture-password",
        "ACCOUNT_JWT_SECRET": "catalog-core-fixture-jwt-secret-never-use-in-production",
        "SUPPORT_PROGRAM_REQUEST_PER_CLIENT_PER_MINUTE": "1000",
        "SUPPORT_PROGRAM_REQUEST_GLOBAL_PER_MINUTE": "1000",
    }
    for source in SOURCES:
        values.update({source + "_SYNC_ENABLED": "true",
                       source + "_SYNC_INITIAL_DELAY": "PT0S",
                       source + "_SYNC_FIXED_DELAY": "PT2S"})
    return values


def validate_boundaries(model, project):
    services = model["services"]
    core = services["core-service"]["environment"]
    catalog = services["catalog-service"]["environment"]
    require(Path(services["catalog-service"]["build"]["context"]).resolve()
            == ROOT / "backend/catalog-service", "Catalog must have a standalone build context")
    require(Path(services["core-service"]["build"]["context"]).resolve()
            == ROOT / "backend/core-service", "Core build context changed")
    require(core["CATALOG_PROJECTION_ENABLED"] == "true", "Core projection is disabled")
    require(core["CATALOG_SERVICE_URL"] == "http://catalog-service:8081", "Wrong catalog DNS")
    require(core["CATALOG_INTERNAL_TOKEN"] == catalog["CATALOG_INTERNAL_TOKEN"] == TOKEN,
            "The server-to-server fixture token was not isolated")
    for source in SOURCES:
        require(core[source + "_SYNC_ENABLED"] == "false", "Core must not collect " + source)
        require(catalog[source + "_SYNC_ENABLED"] == "true", "Catalog fixture source is disabled")
    require(core["SUPPORT_PROGRAM_INDEX_ENABLED"] == "false", "Core must not write search indexes")
    require(catalog["SUPPORT_PROGRAM_INDEX_ENABLED"] == "true", "Catalog indexing is disabled")
    for key in ("DATA_GO_KR_SERVICE_KEY", "KSTARTUP_API_KEY", "MSIT_API_KEY", "CNTRADE_NOTICE_API_KEY"):
        require(core[key] == "", "A source credential reached Core: " + key)
    for key in ("SPRING_DATASOURCE_URL", "SPRING_DATASOURCE_USERNAME", "SPRING_DATASOURCE_PASSWORD"):
        require(core[key] != catalog[key], "Core and Catalog share a database connection: " + key)
    require("catalog-mysql:" in catalog["SPRING_DATASOURCE_URL"], "Catalog points outside its database")
    require(not services["catalog-mysql"].get("ports"), "Catalog MySQL must not publish a host port")
    for name, service in services.items():
        if name not in ("core-service", "catalog-service"):
            require("CATALOG_INTERNAL_TOKEN" not in service.get("environment", {}),
                    "Catalog token reached another service: " + name)
        for port in service.get("ports", []):
            require(port.get("host_ip") == "127.0.0.1", "Non-loopback port: " + name)
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                require(Path(mount["source"]).exists(), "Missing bind path: " + name)
    for key, volume in model["volumes"].items():
        require(not volume.get("external") and volume["name"] == f"{project}_{key}",
                "A verification volume is not isolated: " + key)
    for network in model["networks"].values():
        require(not network.get("external") and network["name"].startswith(project + "_"),
                "A verification network is not isolated")
    build = (ROOT / "backend/catalog-service/build.gradle").read_text()
    require(not any(name in build for name in ("core-api", "core-service")),
            "Catalog Gradle build depends on the Core source tree")
    forbidden = re.compile(r"\bimport\s+ai\.govbiz\.(?:core\.|catalog\.(?:account|chathistory|"
                           r"applicationpreparation|combinationreview|dailyreport|partner|admin)\.)")
    for path in (ROOT / "backend/catalog-service/src/main").rglob("*.kt"):
        require(not forbidden.search(path.read_text()), "User-domain dependency in Catalog: " + str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=300, help="Seconds per readiness condition")
    args = parser.parse_args()
    project = "govbiz-catalog-check-" + uuid.uuid4().hex[:12]
    values = fixture_env()
    ports = iter(range(19080, 19085)) if args.config_only else None
    selected = set()
    for key in ("CORE_API_HOST_PORT", "MYSQL_HOST_PORT", "QDRANT_HOST_PORT", "WEB_HOST_PORT", "CATALOG_HOST_PORT"):
        port = next(ports) if ports else free_port()
        while port in selected:
            port = free_port()
        selected.add(port)
        values[key] = str(port)
    files = [INFRA / "compose.yaml", INFRA / "compose.catalog.yaml"]
    variables = set(values)
    for path in files:
        variables.update(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)", path.read_text()))
    environment = {key: value for key, value in os.environ.items()
                   if key not in variables and not key.startswith(("COMPOSE_", "GOVBIZ_"))}
    environment["COMPOSE_DISABLE_ENV_FILE"] = "true"
    with tempfile.TemporaryDirectory(prefix=project + "-") as directory:
        temp = Path(directory)
        fixture = temp / "fixture.env"
        fixture.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        port_overlay = temp / "ports.json"
        # Cold MySQL/Elasticsearch initialization can exceed the development
        # Compose health budget on a constrained laptop. Keep the original
        # probes, but let the disposable fixture use the requested wait budget.
        fixture_services = {name: {"healthcheck": {"start_period": "60s", "retries": max(12, args.timeout // 5)}}
                            for name in ("mysql", "catalog-mysql", "elasticsearch", "rabbitmq", "core-service", "catalog-service")}
        fixture_services["catalog-service"]["ports"] = [f"127.0.0.1:{values['CATALOG_HOST_PORT']}:8081"]
        port_overlay.write_text(json.dumps({"services": fixture_services}))
        # Limit Compose operations too; image builds below use separate invocations
        # because Bake can otherwise parallelize builds despite --parallel 1.
        compose = ["docker", "compose", "--parallel", "1", "--project-name", project, "--env-file", str(fixture),
                   "--profile", "verification", "--file", str(files[0]), "--file", str(files[1]),
                   "--file", str(port_overlay)]

        def run(arguments, capture=False, check=True, **kwargs):
            return subprocess.run(arguments, env=environment, check=check, text=True,
                                  capture_output=capture, **kwargs)

        def sql(service, statement):
            command = ["exec", "-T", service, "sh", "-c",
                       'exec mysql --batch --skip-column-names --user="$MYSQL_USER" '
                       '--password="$MYSQL_PASSWORD" "$MYSQL_DATABASE"']
            return run(compose + command, capture=True, input=statement + ";\n").stdout.strip()

        model = json.loads(run(compose + ["config", "--format", "json"], capture=True).stdout)
        validate_boundaries(model, project)
        print("PASS: isolated Compose, credentials, scheduler ownership and standalone source boundary", flush=True)
        # Explicit fixture activation must not mask an unsafe opt-in overlay default.
        # Keep the dummy credentials but render again without any writer activation flags.
        writer_flags = {source + "_SYNC_ENABLED" for source in SOURCES} | {"SUPPORT_PROGRAM_INDEX_ENABLED"}
        defaults_fixture = temp / "defaults.env"
        defaults_fixture.write_text("".join(f"{key}={value}\n" for key, value in values.items()
                                           if key not in writer_flags))
        defaults_compose = list(compose)
        defaults_compose[defaults_compose.index(str(fixture))] = str(defaults_fixture)
        defaults_model = json.loads(run(defaults_compose + ["config", "--format", "json"], capture=True).stdout)
        defaults = defaults_model["services"]["catalog-service"]["environment"]
        for flag in sorted(writer_flags):
            require(defaults[flag] == "false", "Catalog writer is enabled without explicit activation: " + flag)
        print("PASS: all Catalog source and index writers default to disabled", flush=True)
        if args.config_only:
            return
        # Never install a cleanup handler until proving that this project owns no existing resources.
        for arguments in (["ps", "--all", "--quiet"], ["network", "ls", "--quiet"], ["volume", "ls", "--quiet"]):
            output = run(["docker", *arguments, "--filter", "label=com.docker.compose.project=" + project], capture=True)
            require(not output.stdout.strip(), "Verification project already has Docker resources")
        print("Starting isolated verification project: " + project, flush=True)
        started = False
        try:
            started = True
            selected_services = ("catalog-service", "core-service", "bizinfo-stub", "kstartup-stub",
                                 "public-notices-stub", "openai-stub", "qdrant")
            required_services = set(selected_services)
            pending = list(selected_services)
            while pending:
                for dependency in model["services"][pending.pop()].get("depends_on", {}):
                    if dependency not in required_services:
                        required_services.add(dependency)
                        pending.append(dependency)
            # Distinct Gradle containers share the BuildKit cache mount. Separate
            # commands avoid both its lock timeout and simultaneous compiler heaps.
            for service in sorted(required_services, key=lambda name: (name not in ("catalog-service", "core-service"), name)):
                if "build" in model["services"][service]:
                    print("Building verification image: " + service, flush=True)
                    run(compose + ["build", service])
            run(compose + ["up", "--no-build", "--detach", "--wait", "--wait-timeout", str(args.timeout),
                           *selected_services])
            catalog_url = "http://127.0.0.1:" + values["CATALOG_HOST_PORT"]
            core_url = "http://127.0.0.1:" + values["CORE_API_HOST_PORT"]
            endpoint = catalog_url + "/internal/v1/catalog/snapshots/"
            for token in (None, "wrong-catalog-fixture-token"):
                status, _ = call_json(endpoint + "BIZINFO", token)
                require(status in (401, 403), "Catalog accepted an absent or invalid token")
            print("PASS: catalog rejects absent and invalid server tokens", flush=True)

            def snapshot(source, failed=False, previous_failure=None):
                code, value = call_json(endpoint + source, TOKEN)
                if code != 200:
                    return None
                status = value["status"]
                require(value["schemaVersion"] == 1 and value["revision"] > 0, "Invalid snapshot version")
                require(status["sourceCode"] == source, "Wrong source in snapshot")
                require(status["publishedProgramCount"] == len(value["programs"]), "Snapshot count mismatch")
                require(re.fullmatch(r"[0-9a-f]{64}", status["publishedCatalogFingerprint"] or ""),
                        "Snapshot fingerprint is absent or invalid")
                if not status["indexReady"] or (failed and (
                    not status["lastFailedSyncAt"] or status["lastFailedSyncAt"] == previous_failure
                    or status["lastSyncOutcome"] != "FAILURE"
                )):
                    return None
                return value

            snapshots = {source: wait_for(source + " published catalog snapshot", lambda source=source: snapshot(source), args.timeout)
                         for source in SOURCES}
            require(len(snapshots["BIZINFO"]["programs"]) == 27, "Incomplete BizInfo fixture")
            require(len(snapshots["KSTARTUP"]["programs"]) == 2, "Incomplete K-Startup fixture")
            require(len(snapshots["MSIT"]["programs"]) == 11, "Incomplete MSIT pagination")
            require(len(snapshots["CNTRADE_NOTICE"]["programs"]) == 2, "Incomplete CNTRADE pagination")

            def projected_catalog():
                code, value = call_json(core_url + "/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN")
                return value if code == 200 and value.get("total") == 2 else None

            baseline = wait_for("Core public catalog reads the HTTP projection", projected_catalog, args.timeout)
            for source, expected in (("MSIT", 11), ("CNTRADE_NOTICE", 2)):
                wait_for(source + " Core projection", lambda source=source, expected=expected:
                         call_json(core_url + "/api/v1/support-programs/catalog?sourceCode=" + source + "&status=UNKNOWN")[1].get("total") == expected,
                         args.timeout)
            catalog_tables = set(sql("catalog-mysql", "SELECT table_name FROM information_schema.tables "
                                     "WHERE table_schema=DATABASE() ORDER BY table_name").splitlines())
            require(catalog_tables == {
                "flyway_schema_history", "catalog_instance", "catalog_source_revision",
                "support_program", "support_program_sync_generation", "support_program_sync_status",
            }, "Catalog database must contain exactly its five catalog tables and Flyway history; found "
               + ", ".join(sorted(catalog_tables)))
            wait_for("four persisted Core projection checkpoints", lambda:
                     sql("mysql", "SELECT COUNT(*) FROM catalog_projection_checkpoint") == "4", args.timeout)
            count_sql = "SELECT source_code,COUNT(*) FROM support_program WHERE is_source_present=TRUE GROUP BY source_code ORDER BY source_code"
            catalog_counts = sql("catalog-mysql", count_sql)
            wait_for("matching Core and Catalog active source counts", lambda:
                     catalog_counts == sql("mysql", count_sql), args.timeout)
            print("PASS: distinct MySQL databases, catalog-only tables and four persisted projection checkpoints", flush=True)

            def search():
                code, value = call_json(core_url + "/api/v1/support-programs/search?" + urllib.parse.urlencode({"query": "서울 AI", "acceptingOnly": "true"}))
                return value if code == 200 and value.get("totalCount", 0) >= 2 else None

            wait_for("Core semantic search through local OpenAI fixtures and real indexes", search, args.timeout)
            before = {source: hashlib.sha256(json.dumps(value["programs"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                      for source, value in snapshots.items()}
            failures_before = {
                source: wait_for(source + " pre-outage status", lambda source=source: snapshot(source), args.timeout)["status"]["lastFailedSyncAt"]
                for source in SOURCES
            }
            run(compose + ["stop", "bizinfo-stub", "kstartup-stub", "public-notices-stub"])
            failed_snapshots = {}
            for source in SOURCES:
                failed = wait_for(source + " upstream failure preserves its published snapshot", lambda source=source:
                                  snapshot(source, failed=True, previous_failure=failures_before[source]), args.timeout)
                failed_snapshots[source] = failed
                after = hashlib.sha256(json.dumps(failed["programs"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                require(after == before[source], "Upstream failure changed published programs: " + source)
                require(failed["status"]["publishedCatalogFingerprint"] == snapshots[source]["status"]["publishedCatalogFingerprint"],
                        "Upstream failure changed the published fingerprint: " + source)

            def projected_failures():
                rows = sql("mysql", "SELECT checkpoint.source_code, checkpoint.revision, status.last_sync_outcome, "
                           "status.last_failed_sync_at FROM catalog_projection_checkpoint checkpoint "
                           "JOIN support_program_sync_status status ON status.source_code=checkpoint.source_code "
                           "ORDER BY checkpoint.source_code")
                checkpoints = {fields[0]: fields[1:] for row in rows.splitlines() if (fields := row.split("\t"))}
                for source, failed in failed_snapshots.items():
                    if source not in checkpoints:
                        return False
                    revision, outcome, failed_at = checkpoints[source]
                    if (int(revision) < failed["revision"] or outcome != "FAILURE"
                            or datetime.fromisoformat(failed_at) < datetime.fromisoformat(failed["status"]["lastFailedSyncAt"])):
                        return False
                return True

            wait_for("Core applies every newer upstream failure revision and status", projected_failures, args.timeout)
            require(sql("catalog-mysql", count_sql) == catalog_counts, "Collection failure deactivated existing catalog data")
            require(sql("mysql", count_sql) == catalog_counts, "Collection failure deactivated the Core projection")
            run(compose + ["stop", "catalog-service"])
            # A retained catalog alone could pass if polling had stopped. Inspect only
            # new logs after the stop completed, without printing logs or credentials.
            stopped_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")

            def polling_retains_projection():
                logs = run(compose + ["logs", "--no-color", "--since", stopped_at, "core-service"], capture=True).stdout
                observed = set(re.findall(r"catalog_projection source=([A-Z_]+) outcome=retained_previous failure=", logs))
                return set(SOURCES) <= observed

            wait_for("Core continues polling all sources and retains previous projections after Catalog stops",
                     polling_retains_projection, args.timeout)
            # Poll across more than one Core refresh interval; retained results must survive failed refreshes.
            for _ in range(4):
                time.sleep(2)
                require(projected_catalog() == baseline, "Catalog outage changed Core's retained public projection")
            wait_for("Core search remains available during the catalog outage", search, args.timeout)
            require(sql("mysql", count_sql) == catalog_counts, "Catalog outage deactivated Core data")
            print("PASS: catalog outage retains Core public catalog/search; no paid APIs were called", flush=True)
        except BaseException:
            run(compose + ["ps"], check=False)
            run(compose + ["logs", "--no-color", "--tail", "100", "catalog-service", "core-service"], check=False)
            raise
        finally:
            if started:
                # Only the fresh random project, checked above, is removed. Existing-data overlays are never used.
                run(compose + ["down", "--volumes", "--remove-orphans"])


if __name__ == "__main__":
    main()
