"""Run Ops-only checks in a NEW disposable kind cluster, never the active context.

No AWS access, real environment files, production data, or paid AI requests.
The caller builds the application image in GovBiz; this repository deploys it.
"""

import argparse
import json
import re
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from copy import deepcopy
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
NAMESPACE = "govbiz-local"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_image(image):
    require(
        bool(
            re.fullmatch(
                r"[a-zA-Z0-9][a-zA-Z0-9._/:-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", image
            )
        )
        and "://" not in image
        and not image.endswith(":latest"),
        "Pass a locally built image with a unique non-latest tag (not a digest or URL).",
    )


def run(command, *, data=None, capture=False):
    result = subprocess.run(
        [str(part) for part in command],
        input=data,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else None


def documents(command):
    return list(yaml.safe_load_all(run(command, capture=True)))


def app_image_resources(resources, image):
    """Replace only the test app image in an already-rendered local overlay."""
    validate_image(image)
    result = deepcopy(resources)
    matches = [
        container
        for item in result
        if item.get("kind") == "Deployment"
        and item.get("metadata", {}).get("name") == "ops-service"
        for container in item["spec"]["template"]["spec"]["containers"]
        if container.get("name") == "ops-service"
    ]
    require(len(matches) == 1, "Expected exactly one Ops image to replace.")
    require(
        matches[0]["image"] == "govbiz-ops-service:local-k8s",
        "Unexpected local image placeholder.",
    )
    matches[0]["image"] = image
    return result


def wait_http(url, expected, timeout=90):
    deadline = time.monotonic() + timeout
    # Do not use environment proxies for a loopback test endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=9) as response:
                status, body = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                status, body = error.code, json.load(error)
            except ValueError:
                time.sleep(1)
                continue
        except (OSError, ValueError):
            time.sleep(1)
            continue
        if status == expected:
            return body
        time.sleep(1)
    raise RuntimeError(f"HTTP check did not reach {expected}: {url}")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def secret_manifest(name, values):
    return json.dumps(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "type": "Opaque",
            "metadata": {"name": name, "namespace": NAMESPACE},
            "stringData": values,
        }
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image", required=True, help="Already-built Ops Gunicorn image."
    )
    parser.add_argument("--kind", default="kind", help="Path to verified kind v0.33.0.")
    args = parser.parse_args()
    validate_image(args.image)
    require("v0.33.0" in run([args.kind, "version"], capture=True), "Use kind v0.33.0.")
    image = json.loads(run(["docker", "image", "inspect", args.image], capture=True))[0]
    require(
        "gunicorn" in " ".join(image["Config"].get("Cmd") or []),
        "Image must start Gunicorn.",
    )
    require(
        image["Config"].get("User", "").split(":")[0] == "10001",
        "Image must use UID 10001.",
    )
    platform = run(
        ["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
        capture=True,
    ).strip()
    require(
        platform == f"{image['Os']}/{image['Architecture']}",
        "Build the Ops image for this Docker host's native platform.",
    )
    cluster = "govbiz-k8s-smoke-" + uuid.uuid4().hex[:10]
    require(
        cluster not in run([args.kind, "get", "clusters"], capture=True).splitlines(),
        "Name collision.",
    )
    db_path = ROOT / "environments/local/ops-mysql"
    db_docs = documents(["kubectl", "kustomize", db_path])
    app_docs = app_image_resources(
        documents(["kubectl", "kustomize", ROOT / "environments/local/ops-service"]),
        args.image,
    )
    mysql_image = next(
        item["spec"]["template"]["spec"]["containers"][0]["image"]
        for item in db_docs
        if item["kind"] == "StatefulSet"
    )
    print(
        f"Creating isolated cluster {cluster}; existing contexts/containers stay unchanged.",
        flush=True,
    )
    report = {
        "cluster": cluster,
        "image_id": image["Id"],
        "mysql_image": mysql_image,
        "checks": [],
    }
    with tempfile.TemporaryDirectory(prefix="govbiz-k8s-smoke-") as directory:
        temp = Path(directory)
        archive = temp / "ops-image.tar"
        # Docker Desktop's OCI index may mention platforms/attestations not present locally.
        # Export only the native platform (Docker API >=1.48) instead of importing all of it.
        run(
            [
                "docker",
                "image",
                "save",
                "--platform",
                platform,
                "--output",
                archive,
                args.image,
            ]
        )
        kubeconfig = temp / "kubeconfig"
        kube = ["kubectl", "--kubeconfig", kubeconfig, "--context", "kind-" + cluster]
        namespaced = kube + ["--namespace", NAMESPACE]
        forwards = []
        started = False

        def apply(docs):
            payload = yaml.safe_dump_all(docs)
            run(
                kube + ["apply", "--dry-run=server", "--validate=strict", "-f", "-"],
                data=payload,
            )
            run(kube + ["apply", "-f", "-"], data=payload)

        def status(kind, name):
            return json.loads(
                run(namespaced + ["get", kind, name, "-o", "json"], capture=True)
            )

        def app_pod(excluding=None):
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                items = json.loads(
                    run(
                        namespaced
                        + [
                            "get",
                            "pods",
                            "-l",
                            "app.kubernetes.io/name=ops-service",
                            "-o",
                            "json",
                        ],
                        capture=True,
                    )
                )["items"]
                live = [
                    item
                    for item in items
                    if not item["metadata"].get("deletionTimestamp")
                ]
                if len(live) == 1 and live[0]["metadata"]["uid"] != excluding:
                    return live[0]
                time.sleep(1)
            raise RuntimeError("Expected exactly one active replacement Ops Pod.")

        def forward(pod):
            port = free_port()
            process = subprocess.Popen(
                [
                    str(part)
                    for part in namespaced
                    + [
                        "port-forward",
                        "--address",
                        "127.0.0.1",
                        "pod/" + pod,
                        f"{port}:8000",
                    ]
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            forwards.append(process)
            return f"http://127.0.0.1:{port}"

        try:
            started = True
            run(
                [
                    args.kind,
                    "create",
                    "cluster",
                    "--name",
                    cluster,
                    "--kubeconfig",
                    kubeconfig,
                    "--config",
                    ROOT / "kind/local.yaml",
                    "--wait",
                    "180s",
                ]
            )
            run([args.kind, "load", "image-archive", archive, "--name", cluster])
            apply(
                list(
                    yaml.safe_load_all(
                        (ROOT / "environments/local/namespace.yaml").read_text(
                            encoding="utf-8"
                        )
                    )
                )
            )
            password = secrets.token_urlsafe(32)
            # Generated test credentials are sent on stdin, not command-line args or logs.
            for name, values in (
                (
                    "govbiz-ops-runtime",
                    {
                        "DJANGO_SECRET_KEY": secrets.token_urlsafe(48),
                        "DB_PASSWORD": password,
                    },
                ),
                (
                    "govbiz-ops-mysql",
                    {
                        "MYSQL_ROOT_PASSWORD": secrets.token_urlsafe(32),
                        "MYSQL_PASSWORD": password,
                    },
                ),
            ):
                run(kube + ["create", "-f", "-"], data=secret_manifest(name, values))
            apply(db_docs)
            run(
                namespaced
                + ["rollout", "status", "statefulset/ops-mysql", "--timeout=240s"]
            )
            # Only the in-memory test image differs from the checked-in local overlay.
            apply(app_docs)
            run(
                namespaced
                + ["rollout", "status", "deployment/ops-service", "--timeout=180s"]
            )
            pod = app_pod()
            report["running_image_id"] = pod["status"]["containerStatuses"][0][
                "imageID"
            ]
            url = forward(pod["metadata"]["name"])
            require(
                wait_http(url + "/api/v1/health", 200)
                == {"status": "UP", "service": "govbiz-ops-service"},
                "Liveness or service identity failed.",
            )
            require(
                wait_http(url + "/api/v1/health/ready", 200)["checks"]["database"]
                == "UP",
                "Readiness failed.",
            )
            report["checks"].append(
                "server-side schema validation; Gunicorn liveness; MySQL8.4 readiness"
            )
            # Application pod must use Service DNS and only its own DB credentials.
            run(
                namespaced
                + [
                    "exec",
                    "deployment/ops-service",
                    "--",
                    "python",
                    "manage.py",
                    "check",
                ]
            )
            run(
                namespaced
                + [
                    "exec",
                    "deployment/ops-service",
                    "--",
                    "python",
                    "manage.py",
                    "makemigrations",
                    "--check",
                    "--dry-run",
                ]
            )
            run(
                namespaced
                + [
                    "exec",
                    "deployment/ops-service",
                    "--",
                    "python",
                    "-c",
                    "import socket; print('DB DNS OK:', bool(socket.getaddrinfo('ops-mysql',3306)))",
                ]
            )
            # Persist a harmless marker only in this newly created test DB.
            db_marker = "CREATE TABLE k8s_smoke_marker (id INT PRIMARY KEY); INSERT INTO k8s_smoke_marker VALUES (1);"
            run(
                namespaced
                + [
                    "exec",
                    "ops-mysql-0",
                    "--",
                    "sh",
                    "-ec",
                    'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u govbiz_ops -D govbiz_ops -e "$1"',
                    "smoke",
                    db_marker,
                ]
            )
            mysql_uid = status("pod", "ops-mysql-0")["metadata"]["uid"]
            restarts = pod["status"]["containerStatuses"][0]["restartCount"]
            run(namespaced + ["scale", "statefulset/ops-mysql", "--replicas=0"])
            run(
                namespaced
                + ["wait", "--for=delete", "pod/ops-mysql-0", "--timeout=90s"]
            )
            require(
                wait_http(url + "/api/v1/health/ready", 503)["status"] == "DOWN",
                "DB failure hidden.",
            )
            run(
                namespaced
                + [
                    "wait",
                    "--for=condition=Ready=false",
                    "pod/" + pod["metadata"]["name"],
                    "--timeout=90s",
                ]
            )
            require(
                wait_http(url + "/api/v1/health", 200)["status"] == "UP",
                "DB outage must not fail liveness.",
            )
            require(
                app_pod()["status"]["containerStatuses"][0]["restartCount"] == restarts,
                "DB outage restarted the app.",
            )
            run(namespaced + ["scale", "statefulset/ops-mysql", "--replicas=1"])
            run(
                namespaced
                + ["rollout", "status", "statefulset/ops-mysql", "--timeout=240s"]
            )
            wait_http(url + "/api/v1/health/ready", 200)
            require(
                status("pod", "ops-mysql-0")["metadata"]["uid"] != mysql_uid,
                "DB Pod was not recreated.",
            )
            output = run(
                namespaced
                + [
                    "exec",
                    "ops-mysql-0",
                    "--",
                    "sh",
                    "-ec",
                    'MYSQL_PWD="$MYSQL_PASSWORD" mysql -N -u govbiz_ops -D govbiz_ops -e "SELECT COUNT(*) FROM k8s_smoke_marker"',
                ],
                capture=True,
            )
            require(output.strip() == "1", "PVC marker was not preserved.")
            report["checks"].append(
                "DB outage -> readiness503/Pod NotReady; liveness200/no app restart; recovery/PVC marker preserved"
            )
            old_uid = pod["metadata"]["uid"]
            run(namespaced + ["delete", "pod", pod["metadata"]["name"], "--wait=true"])
            run(
                namespaced
                + ["rollout", "status", "deployment/ops-service", "--timeout=180s"]
            )
            replacement = app_pod(excluding=old_uid)
            require(
                replacement["metadata"]["uid"] != old_uid,
                "Deployment did not recreate the Pod.",
            )
            replacement_url = forward(replacement["metadata"]["name"])
            wait_http(replacement_url + "/api/v1/health/ready", 200)
            report["checks"].append(
                "Deployment replaced deleted Ops Pod; DB readiness recovered"
            )
            # Prove a failed rollout keeps the healthy old replica and can be reverted.
            run(
                namespaced
                + [
                    "set",
                    "image",
                    "deployment/ops-service",
                    "ops-service=govbiz-ops-service:deliberately-missing-smoke",
                ]
            )
            failed = subprocess.run(
                [
                    str(part)
                    for part in namespaced
                    + [
                        "rollout",
                        "status",
                        "deployment/ops-service",
                        "--timeout=25s",
                    ]
                ],
                check=False,
            )
            require(failed.returncode != 0, "Missing image unexpectedly rolled out.")
            require(
                status("deployment", "ops-service")["status"].get(
                    "availableReplicas", 0
                )
                >= 1,
                "Failed rollout removed healthy replica.",
            )
            wait_http(replacement_url + "/api/v1/health/ready", 200)
            run(namespaced + ["rollout", "undo", "deployment/ops-service"])
            run(
                namespaced
                + ["rollout", "status", "deployment/ops-service", "--timeout=180s"]
            )
            restored = app_pod()
            require(
                restored["spec"]["containers"][0]["image"] == args.image,
                "Rollback did not restore image.",
            )
            wait_http(
                forward(restored["metadata"]["name"]) + "/api/v1/health/ready", 200
            )
            report["checks"].append(
                "failed image rollout preserves availability; previous image restored (not a DB rollback)"
            )
            print("GOVBIZ_KUBERNETES_LOCAL_OK", flush=True)
            print(json.dumps(report, indent=2), flush=True)
        finally:
            for process in forwards:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if started:
                run(
                    [
                        args.kind,
                        "delete",
                        "cluster",
                        "--name",
                        cluster,
                        "--kubeconfig",
                        kubeconfig,
                    ]
                )
                print(
                    f"Removed only temporary cluster {cluster}, including its generated test secrets and PVC.",
                    flush=True,
                )


if __name__ == "__main__":
    main()
