"""Validate the combined model and optionally smoke-test Django in an isolated project."""

import argparse
import json
import os
import re
import socket
import subprocess
import tempfile
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT
DJANGO = ROOT / "backend" / "ops-service"
EXISTING_VOLUMES = {
    "elasticsearch-data": "govbiz_elasticsearch-data",
    "rabbitmq-data": "govbiz_rabbitmq-data",
    "redis-data": "govbiz_redis-data",
    "mysql-data": "govbiz_mysql-data",
    "qdrant-data": "govbiz_qdrant-data",
    "ops-mysql-data": "govbiz4-django_mysql-data",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def write_env(path, values):
    path.write_text(
        "".join(f"{key}={value}\n" for key, value in values.items()),
        encoding="utf-8",
    )


def run(command, environment, *, capture=False):
    return subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=True,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def validate(model, project):
    services = model["services"]
    require(
        {
            "web",
            "core-service",
            "catalog-service",
            "catalog-mysql",
            "ai-service",
            "mysql",
            "elasticsearch",
            "qdrant",
            "redis",
            "rabbitmq",
            "demo-seed",
            "ops-service",
            "ops-mysql",
        }
        <= services.keys(),
        "A required service is missing.",
    )
    require(
        not {"db", "core-api", "django-api", "django-mysql"}.intersection(services),
        "A retired runtime service name leaked into the model."
    )
    require(
        set(services["ops-service"]["depends_on"]) == {"ops-mysql"},
        "Django must depend only on its own database.",
    )
    require(
        services["ops-service"]["environment"]["DB_HOST"] == "ops-mysql",
        "Django database DNS is incorrect.",
    )
    require(
        "ops-service"
        in services["ops-service"]["environment"]["DJANGO_ALLOWED_HOSTS"].split(","),
        "The integrated Django hostname must be allowed.",
    )
    require(
        services["web"]["environment"]["VITE_DEV_PROXY_TARGET"]
        == "http://core-service:8080",
        "The existing frontend proxy changed.",
    )
    # Distinct fixture values catch accidental environment leakage between includes.
    for service, expected in (
        ("mysql", "app-root-fixture"),
        ("ops-mysql", "django-root-fixture"),
    ):
        require(
            services[service]["environment"]["MYSQL_ROOT_PASSWORD"] == expected,
            f"Environment isolation failed for {service}.",
        )
    require(
        services["ops-service"]["environment"]["DB_PASSWORD"] == "django-user-fixture",
        "Django did not receive its selected environment file.",
    )
    require(
        services["core-service"]["environment"]["SPRING_DATASOURCE_PASSWORD"]
        == "app-user-fixture",
        "The Core API did not receive its selected environment file.",
    )
    core = services["core-service"]["environment"]
    catalog = services["catalog-service"]["environment"]
    require(core["CATALOG_PROJECTION_ENABLED"] == "true", "Default Core must use Catalog projection.")
    require(core["CATALOG_SERVICE_URL"] == "http://catalog-service:8081", "Incorrect Catalog DNS.")
    require(core["CATALOG_INTERNAL_TOKEN"] == catalog["CATALOG_INTERNAL_TOKEN"]
            == "root-compose-catalog-fixture-token-never-use", "Catalog token isolation failed.")
    for flag in ("BIZINFO_SYNC_ENABLED", "KSTARTUP_SYNC_ENABLED", "MSIT_SYNC_ENABLED",
                 "CNTRADE_NOTICE_SYNC_ENABLED", "SUPPORT_PROGRAM_INDEX_ENABLED"):
        require(core[flag] == "false", "Default Core must not own source/index writes: " + flag)
        require(catalog[flag] == "false", "Fixture must not activate paid source/index work: " + flag)
    for key in ("DATA_GO_KR_SERVICE_KEY", "KSTARTUP_API_KEY", "MSIT_API_KEY", "CNTRADE_NOTICE_API_KEY"):
        require(core[key] == "", "Source credentials must not reach Core: " + key)
    require(catalog["SPRING_DATASOURCE_URL"].startswith("jdbc:mysql://catalog-mysql:3306/"),
            "Catalog must use its own database.")
    for key in ("SPRING_DATASOURCE_URL", "SPRING_DATASOURCE_USERNAME", "SPRING_DATASOURCE_PASSWORD"):
        require(core[key] != catalog[key], "Database credentials must not be shared: " + key)
    require(not services["catalog-mysql"].get("ports"), "Do not expose Catalog DB on the host.")

    for name, path in {
        "web": APP,
        "core-service": APP / "backend/core-service",
        "catalog-service": APP / "backend/catalog-service",
        "ai-service": APP / "backend/ai-service",
        "elasticsearch": APP / "infrastructure/elasticsearch",
        "ops-service": DJANGO,
    }.items():
        build = services[name]["build"]
        require(
            Path(build["context"]).resolve() == path.resolve(),
            f"Wrong build path: {name}",
        )
        require(
            (path / build.get("dockerfile", "Dockerfile")).is_file(),
            f"Missing Dockerfile: {name}",
        )
    for name, service in services.items():
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                require(Path(mount["source"]).exists(), f"Missing bind source: {name}")
        for port in service.get("ports", []):
            require(
                port.get("host_ip") == "127.0.0.1", f"Non-local published port: {name}"
            )

    web_mounts = {v["target"]: v for v in services["web"]["volumes"]}
    require(
        services["web"]["working_dir"] == "/app/frontend/web",
        "The web development server must run in its workspace.",
    )
    for target, source in (
        ("/app/frontend/web", APP / "frontend/web"),
        ("/app/frontend/mobile/package.json", APP / "frontend/mobile/package.json"),
        ("/app/frontend/packages/shared", APP / "frontend/packages/shared"),
        ("/app/pnpm-lock.yaml", APP / "pnpm-lock.yaml"),
    ):
        require(
            Path(web_mounts[target]["source"]).resolve() == source.resolve(),
            f"Incorrect web workspace mount: {target}",
        )
    require(
        web_mounts["/app/node_modules"]["source"] == "web-workspace-node-modules",
        "The old single-app dependency cache must not be reused as the workspace root.",
    )

    django_mounts = {v["target"]: v for v in services["ops-service"]["volumes"]}
    require(
        Path(django_mounts["/app/config"]["source"]).resolve()
        == (DJANGO / "config").resolve(),
        "Django source mount points outside backend/ops-service.",
    )
    for name, volume in (
        ("mysql", "mysql-data"),
        ("ops-mysql", "ops-mysql-data"),
    ):
        mounts = {v["target"]: v for v in services[name]["volumes"]}
        require(
            mounts["/var/lib/mysql"]["source"] == volume,
            f"Database storage is not separated: {name}",
        )
    db_mounts = {v["target"]: v for v in services["ops-mysql"]["volumes"]}
    sql = "/docker-entrypoint-initdb.d/01-development-test-database.sql"
    require(
        Path(db_mounts[sql]["source"]).resolve()
        == (DJANGO / "infrastructure/mysql/01-development-test-database.sql").resolve(),
        "Django database initialization SQL was lost.",
    )
    require(model["name"] == project, "Unexpected test project name.")
    for key, value in model["volumes"].items():
        require(
            not value.get("external"), "A smoke test must never mount existing data."
        )
        require(value["name"] == f"{project}_{key}", "A test volume is not isolated.")
    for value in model["networks"].values():
        require(
            not value.get("external"), "A smoke test must not join an existing network."
        )
        require(
            value["name"].startswith(project + "_"), "A test network is not isolated."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--smoke", action="store_true", help="Build and test only Django/MySQL."
    )
    args = parser.parse_args()
    require(
        (APP / "infrastructure/compose.yaml").is_file()
        and (DJANGO / "compose.yaml").is_file(),
        "Missing application Compose or backend/ops-service source; use the GovBiz monorepo.",
    )
    project = "govbiz-infra-check-" + uuid.uuid4().hex[:12]
    # Static validation does not bind sockets or require the Docker engine.
    api_port, mysql_port = (unused_port(), unused_port()) if args.smoke else (18001, 13308)
    while api_port == mysql_port:
        mysql_port = unused_port()

    with tempfile.TemporaryDirectory(prefix="govbiz-infra-check-") as directory:
        temp = Path(directory)
        app_env = {
            "OPENAI_API_KEY": "infra-config-only-never-sent",
            "CATALOG_INTERNAL_TOKEN": "root-compose-catalog-fixture-token-never-use",
            "MYSQL_ROOT_PASSWORD": "app-root-fixture",
            "MYSQL_PASSWORD": "app-user-fixture",
            "MYSQL_HOST_PORT": "3307",
            "BIZINFO_SYNC_ENABLED": "false",
            "KSTARTUP_SYNC_ENABLED": "false",
            "MSIT_SYNC_ENABLED": "false",
            "CNTRADE_NOTICE_SYNC_ENABLED": "false",
            "SUPPORT_PROGRAM_INDEX_ENABLED": "false",
            "DEMO_SEED_ENABLED": "false",
        }
        django_env = {
            "DJANGO_SECRET_KEY": "infra-test-only-django-key-not-for-deployment-2026",
            "DJANGO_DEBUG": "false",
            "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",
            "DB_NAME": "govbiz4",
            "DB_USER": "govbiz4",
            "DB_PASSWORD": "django-user-fixture",
            "DB_HOST": "127.0.0.1",
            "DB_PORT": str(mysql_port),
            "MYSQL_ROOT_PASSWORD": "django-root-fixture",
            "API_PORT": str(api_port),
            "MYSQL_PORT": str(mysql_port),
        }
        write_env(temp / "app.env", app_env)
        write_env(temp / "django.env", django_env)
        write_env(
            temp / "infra.env",
            {
                "GOVBIZ_APP_ENV_FILE": (temp / "app.env").as_posix(),
                "GOVBIZ_DJANGO_ENV_FILE": (temp / "django.env").as_posix(),
                "GOVBIZ_CATALOG_TRANSITION_REVIEWED": "1",
            },
        )
        # Clear every interpolation variable used by the models, not just fixture keys.
        # Local developer environment files and shell-provided API keys are not used.
        compose_paths = [
            ROOT / "compose.yaml",
            ROOT / "compose.ops.yaml",
            ROOT / "compose.existing-data.yaml",
            APP / "infrastructure/compose.yaml",
            APP / "infrastructure/compose.catalog.yaml",
            DJANGO / "compose.yaml",
        ]
        variables = set(app_env) | set(django_env)
        for path in compose_paths:
            variables.update(
                re.findall(
                    r"\$\{([A-Za-z_][A-Za-z0-9_]*)", path.read_text(encoding="utf-8")
                )
            )
        environment = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("COMPOSE_", "GOVBIZ_")) and k not in variables
        }
        base = [
            "docker",
            "compose",
            "--project-name",
            project,
            "--env-file",
            str(temp / "infra.env"),
            "--file",
            str(ROOT / "compose.yaml"),
        ]
        model = json.loads(
            run(base + ["config", "--format", "json"], environment, capture=True).stdout
        )
        validate(model, project)
        existing = json.loads(
            run(
                base
                + [
                    "--file",
                    str(ROOT / "compose.existing-data.yaml"),
                    "config",
                    "--format",
                    "json",
                ],
                environment,
                capture=True,
            ).stdout
        )
        for key, name in EXISTING_VOLUMES.items():
            value = existing["volumes"][key]
            require(
                value.get("external") is True and value["name"] == name,
                f"Existing volume mapping is incorrect: {key}",
            )
        require(
            "web-node-modules" not in existing["volumes"],
            "The old single-app cache leaked into the data-volume override.",
        )
        for key in (
            "web-workspace-node-modules",
            "web-frontend-node-modules",
            "web-shared-node-modules",
        ):
            value = existing["volumes"][key]
            require(
                not value.get("external") and value["name"] == f"{project}_{key}",
                f"Node dependencies must use new, project-local volumes: {key}",
            )
        print(
            "PASS: paths, service names, environment isolation, dependencies and volume mappings.",
            flush=True,
        )
        if not args.smoke:
            return

        run(base + ["build", "ops-service"], environment)
        started = False
        try:
            started = True
            run(
                base
                + [
                    "up",
                    "--detach",
                    "--no-build",
                    "--wait",
                    "--wait-timeout",
                    "180",
                    "ops-service",
                ],
                environment,
            )
            with urllib.request.urlopen(
                f"http://127.0.0.1:{api_port}/api/v1/health/ready", timeout=10
            ) as response:
                require(
                    response.status == 200 and json.load(response)["status"] == "UP",
                    "Django readiness failed.",
                )
            for arguments in (
                ["check"],
                ["makemigrations", "--check", "--dry-run"],
                ["test", "--noinput"],
            ):
                run(
                    base + ["exec", "-T", "ops-service", "python", "manage.py"] + arguments,
                    environment,
                )
            probe = (
                "import json,urllib.request; "
                "r=urllib.request.urlopen('http://ops-service:8000/api/v1/health/ready',timeout=10); "
                "assert r.status == 200 and json.load(r)['status'] == 'UP'; "
                "print('PASS: Django service DNS and database readiness.')"
            )
            run(
                base
                + ["run", "--rm", "--no-deps", "ops-service", "python", "-c", probe],
                environment,
            )
        finally:
            if started:
                # base explicitly selects only compose.yaml and a random, verified project.
                # External-volume overrides are never used for runtime tests.
                run(base + ["down", "--volumes"], environment)
        print(
            "PASS: isolated Docker build, real MySQL tests, HTTP and service DNS.",
            flush=True,
        )


if __name__ == "__main__":
    main()
