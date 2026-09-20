"""Render and check the local Ops manifests without contacting a cluster.

These project policies are not Kubernetes schema validation, admission control,
runtime testing, NetworkPolicy enforcement, or proof of production readiness.
"""

import re
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
NAMESPACE = "govbiz-local"
APP_OVERLAY = "environments/local/ops-service"
DB_OVERLAY = "environments/local/ops-mysql"
BASE = "environments/services/ops-service/base"


def render_overlay(path):
    result = subprocess.run(
        ["kubectl", "kustomize", str(path)],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return [resource for resource in yaml.safe_load_all(result.stdout) if resource]


def load_resources(root=ROOT):
    namespace = yaml.safe_load((root / "environments/local/namespace.yaml").read_text())
    return [
        namespace,
        *render_overlay(root / APP_OVERLAY),
        *render_overlay(root / DB_OVERLAY),
    ]


def policy_errors(resources):
    errors = []

    def require(condition, description):
        if not condition:
            errors.append(description)

    allowed = {"Namespace", "ConfigMap", "Service", "Deployment", "StatefulSet"}
    by_key = {}
    for resource in resources:
        kind = resource.get("kind")
        metadata = resource.get("metadata", {})
        name = metadata.get("name", "")
        key = (kind, name)
        require(key not in by_key, f"Duplicate resource: {kind}/{name}")
        by_key[key] = resource
        require(kind in allowed, f"Unexpected resource kind: {kind}")
        if kind == "Namespace":
            require(name == NAMESPACE, "Namespace must be govbiz-local")
        else:
            require(
                metadata.get("namespace") == NAMESPACE,
                f"Wrong namespace: {kind}/{name}",
            )
        if kind == "ConfigMap":
            for variable in resource.get("data", {}):
                require(
                    re.search(
                        r"PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY", variable, re.I
                    )
                    is None,
                    f"Secret-like ConfigMap key is forbidden: {variable}",
                )
            require(
                not resource.get("binaryData"), "Binary ConfigMap data is not supported"
            )
        if kind == "Service":
            spec = resource.get("spec", {})
            require(
                spec.get("type", "ClusterIP") == "ClusterIP",
                "Only internal ClusterIP services are allowed",
            )
            require(not spec.get("externalIPs"), "External service IPs are forbidden")
            require(not spec.get("loadBalancerIP"), "Load balancer IPs are forbidden")
            require(
                all("nodePort" not in p for p in spec.get("ports", [])),
                "NodePort is forbidden",
            )
        if kind in {"Deployment", "StatefulSet"}:
            pod = resource.get("spec", {}).get("template", {}).get("spec", {})
            require(
                pod.get("automountServiceAccountToken") is False,
                f"Disable API token mount: {name}",
            )
            require(
                not pod.get("hostNetwork")
                and not pod.get("hostPID")
                and not pod.get("hostIPC"),
                "Host namespaces are forbidden",
            )
            require(
                all("hostPath" not in volume for volume in pod.get("volumes", [])),
                "hostPath volumes are forbidden",
            )
            require(
                not pod.get("initContainers"),
                "No implicit migration/init containers in this phase",
            )
            containers = pod.get("containers", [])
            require(len(containers) == 1, f"Expected exactly one container: {name}")
            for container in containers:
                context = container.get("securityContext", {})
                require(
                    not context.get("privileged"), "Privileged containers are forbidden"
                )
                require(
                    all("hostPort" not in p for p in container.get("ports", [])),
                    "Host ports are forbidden",
                )
                require(
                    not container.get("command"),
                    "Do not replace the image's runtime command",
                )
                for resource_type in ("requests", "limits"):
                    budget = container.get("resources", {}).get(resource_type, {})
                    require(
                        bool(budget.get("cpu")) and bool(budget.get("memory")),
                        f"CPU and memory {resource_type} are required: {name}",
                    )
                for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
                    require(bool(container.get(probe)), f"Missing {probe}: {name}")
                for source in container.get("envFrom", []):
                    require(
                        set(source) == {"configMapRef"},
                        "Only explicit secretKeyRef secrets are allowed",
                    )
                    target = source.get("configMapRef", {}).get("name")
                    require(
                        ("ConfigMap", target) in by_key
                        or any(
                            item.get("kind") == "ConfigMap"
                            and item.get("metadata", {}).get("name") == target
                            for item in resources
                        ),
                        f"Missing ConfigMap: {target}",
                    )

    def get(kind, name):
        result = by_key.get((kind, name), {})
        require(bool(result), f"Missing resource: {kind}/{name}")
        return result

    get("Namespace", NAMESPACE)
    deployment = get("Deployment", "ops-service")
    app_spec = deployment.get("spec", {})
    require(app_spec.get("replicas") == 1, "Local Ops starts with one replica")
    require(
        app_spec.get("strategy", {}).get("rollingUpdate")
        == {"maxUnavailable": 0, "maxSurge": 1},
        "Keep the healthy replica during a rolling update",
    )
    app_pod = app_spec.get("template", {}).get("spec", {})
    require(
        app_pod.get("terminationGracePeriodSeconds", 0) >= 40,
        "Allow Gunicorn graceful shutdown",
    )
    security = app_pod.get("securityContext", {})
    require(
        security.get("runAsNonRoot") is True and security.get("runAsUser") == 10001,
        "Ops must run as non-root UID 10001",
    )
    require(
        security.get("runAsGroup") == 10001 and security.get("fsGroup") == 10001,
        "Ops writable volume group must be 10001",
    )
    require(
        security.get("seccompProfile", {}).get("type") == "RuntimeDefault",
        "Ops requires RuntimeDefault seccomp",
    )
    containers = app_pod.get("containers", [])
    app = containers[0] if containers else {}
    require(
        app.get("name") == "ops-service", "Ops container name must be ops-service"
    )
    require(
        app.get("image") == "govbiz-ops-service:local-k8s",
        "Checked-in local image must be govbiz-ops-service:local-k8s",
    )
    require(
        app.get("imagePullPolicy") == "Never",
        "Load the local Ops image explicitly; do not pull it",
    )
    context = app.get("securityContext", {})
    require(
        context.get("readOnlyRootFilesystem") is True,
        "Ops root filesystem must be read-only",
    )
    require(
        context.get("allowPrivilegeEscalation") is False,
        "Ops privilege escalation must be disabled",
    )
    require(
        context.get("capabilities", {}).get("drop") == ["ALL"],
        "Ops must drop all Linux capabilities",
    )
    for name, path in (
        ("startupProbe", "/api/v1/health"),
        ("livenessProbe", "/api/v1/health"),
        ("readinessProbe", "/api/v1/health/ready"),
    ):
        probe = app.get(name, {}).get("httpGet", {})
        require(
            probe.get("path") == path and probe.get("port") == "http",
            f"Wrong Ops {name} endpoint",
        )
        require(
            {"name": "Host", "value": "localhost"} in probe.get("httpHeaders", []),
            f"Set the Django Host header for {name}",
        )
    require(
        app.get("readinessProbe", {}).get("timeoutSeconds", 0) > 5,
        "Readiness probe must allow the 5-second DB timeout",
    )
    require(
        app.get("volumeMounts") == [{"name": "tmp", "mountPath": "/tmp"}],
        "Only /tmp is writable in Ops",
    )
    require(
        app_pod.get("volumes")
        == [{"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"}}],
        "Ops temporary storage must be a bounded emptyDir",
    )
    check_secret_env(
        app,
        {
            "DJANGO_SECRET_KEY": ("govbiz-ops-runtime", "DJANGO_SECRET_KEY"),
            "DB_PASSWORD": ("govbiz-ops-runtime", "DB_PASSWORD"),
        },
        require,
    )

    app_configs = [
        item
        for item in resources
        if item.get("kind") == "ConfigMap"
        and item.get("metadata", {})
        .get("name", "")
        .startswith("ops-service-config-")
    ]
    require(len(app_configs) == 1, "One hashed Ops ConfigMap is required")
    if len(app_configs) == 1:
        config = app_configs[0].get("data", {})
        expected = {
            "DJANGO_DEBUG": "false",
            "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1,ops-service,ops-service.govbiz-local.svc.cluster.local",
            "DB_NAME": "govbiz_ops",
            "DB_USER": "govbiz_ops",
            "DB_HOST": "ops-mysql",
            "DB_PORT": "3306",
        }
        require(config == expected, "Unexpected local Ops environment configuration")
    for name, port in (("ops-service", 8000), ("ops-mysql", 3306)):
        service = get("Service", name).get("spec", {})
        require(
            service.get("selector") == {"app.kubernetes.io/name": name},
            f"Wrong service selector: {name}",
        )
        require(
            len(service.get("ports", [])) == 1
            and service["ports"][0].get("port") == port,
            f"Wrong service port: {name}",
        )

    db = get("StatefulSet", "ops-mysql").get("spec", {})
    require(
        db.get("replicas") == 1 and db.get("serviceName") == "ops-mysql",
        "Local MySQL must be a single StatefulSet replica",
    )
    db_containers = db.get("template", {}).get("spec", {}).get("containers", [])
    mysql = db_containers[0] if db_containers else {}
    require(
        bool(re.fullmatch(r"mysql:8\.4@sha256:[0-9a-f]{64}", mysql.get("image", ""))),
        "Pin official MySQL 8.4 by digest",
    )
    check_secret_env(
        mysql,
        {
            "MYSQL_ROOT_PASSWORD": ("govbiz-ops-mysql", "MYSQL_ROOT_PASSWORD"),
            "MYSQL_PASSWORD": ("govbiz-ops-mysql", "MYSQL_PASSWORD"),
        },
        require,
    )
    require(
        "--character-set-server=utf8mb4" in mysql.get("args", []),
        "Use utf8mb4 in the local DB",
    )
    claims = db.get("volumeClaimTemplates", [])
    require(
        len(claims) == 1 and claims[0].get("metadata", {}).get("name") == "data",
        "MySQL requires its own data PVC",
    )
    if len(claims) == 1:
        claim = claims[0].get("spec", {})
        require(
            claim.get("accessModes") == ["ReadWriteOnce"],
            "Local MySQL PVC must be ReadWriteOnce",
        )
        require(
            claim.get("resources", {}).get("requests", {}).get("storage") == "1Gi",
            "Keep local database storage bounded at 1Gi",
        )
    require(
        len(resources) == 7,
        "Only the local namespace, two workloads, two Services and two ConfigMaps are expected",
    )
    return errors


def check_secret_env(container, expected, require):
    entries = container.get("env", [])
    require(
        {entry.get("name") for entry in entries} == set(expected)
        and len(entries) == len(expected),
        "Unexpected or missing secret environment variable",
    )
    for entry in entries:
        name = entry.get("name")
        if name not in expected:
            continue
        secret_name, key = expected[name]
        require(
            entry
            == {
                "name": name,
                "valueFrom": {"secretKeyRef": {"name": secret_name, "key": key}},
            },
            f"Use the required secretKeyRef for {name}; never commit a secret value",
        )


def main():
    resources = load_resources()
    errors = policy_errors(resources)
    base = render_overlay(ROOT / BASE)
    if {(item.get("kind"), item.get("metadata", {}).get("name")) for item in base} != {
        ("Deployment", "ops-service"),
        ("Service", "ops-service"),
    }:
        errors.append(
            "The reusable Ops base must not contain a database, namespace, or local configuration"
        )
    if errors:
        raise SystemExit("\n".join(errors))
    print("PASS: local Kubernetes rendering and project safety policies.")
    print(
        "No cluster contacted; schema admission, runtime recovery, network isolation and production readiness are separate checks."
    )


if __name__ == "__main__":
    main()
