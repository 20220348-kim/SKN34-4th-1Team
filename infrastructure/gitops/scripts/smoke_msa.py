"""Exercise four real services in a new disposable kind cluster using local fixtures.

No real .env, cloud resources, developer volumes, public source APIs or paid LLM.
Build images with GovBiz/infrastructure/scripts/build-msa-images.py first.
"""

import argparse
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

import yaml

from check_msa import ROOT, SERVICES, NAMESPACE, render, policy_errors
from smoke_kubernetes import free_port, wait_http, validate_image

STUBS = {"openai-stub": 8002, "bizinfo-stub": 8001,
         "kstartup-stub": 8003, "public-notices-stub": 8004}


def run(command, *, data=None, capture=False, check=True, timeout=600):
    result = subprocess.run([str(p) for p in command], input=data, text=True, check=check,
                            capture_output=capture, timeout=timeout)
    return result.stdout if capture else result.returncode


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def wait_for(label, probe, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = probe()
            if result:
                print("PASS: " + label, flush=True)
                return result
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        time.sleep(3)
    raise RuntimeError("Timed out: " + label)


def validate_manifest(manifest):
    expected = set(SERVICES) | set(STUBS) | {"elasticsearch"}
    require(set(manifest["images"]) == expected, "Expected all nine application/fixture images")
    require(set(manifest["imageIds"]) == expected, "Missing verified image identities")
    for name, image in manifest["images"].items():
        validate_image(image)
        require(image.startswith("govbiz-" + name + ":msa-"), "Use dedicated MSA fixture image names")
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", manifest["imageIds"][name]), "Invalid image ID")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--kind", default="kind")
    parser.add_argument("--helm", default="helm")
    gitops = parser.add_mutually_exclusive_group()
    gitops.add_argument("--gitops-revisions", nargs=2, metavar=("BASE_SHA", "AI_ONLY_SHA"),
                        help="Optional already-pushed infra revisions; installs Argo CD Core in this new cluster")
    gitops.add_argument("--gitops-interactive", action="store_true",
                        help="After runtime checks pass, accept two pushed SHAs on a terminal, reusing this cluster")
    args = parser.parse_args()
    if args.gitops_interactive and not sys.stdin.isatty():
        parser.error("Interactive GitOps requires a terminal; use --gitops-revisions for unattended checks")
    if args.gitops_revisions:
        from gitops_msa import validate_revisions
        validate_revisions(args.gitops_revisions)
    require(not args.report.exists(), "Report must be a new file")
    manifest = json.loads(args.images.read_text())
    validate_manifest(manifest)
    images = manifest["images"]
    platform = run(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], capture=True).strip()
    for name, image in images.items():
        actual = json.loads(run(["docker", "image", "inspect", image], capture=True))[0]
        require(actual["Id"] == manifest["imageIds"][name], "Image changed since build: " + name)
        require(platform == actual["Os"] + "/" + actual["Architecture"], "Non-native image: " + name)
    require("v0.33.0" in run([args.kind, "version"], capture=True), "Use kind v0.33.0")
    cluster = "govbiz-msa-smoke-" + uuid.uuid4().hex[:10]
    require(cluster not in run([args.kind, "get", "clusters"], capture=True).splitlines(), "Cluster collision")
    report = {"cluster": cluster, "revision": manifest["revision"], "dirty": manifest["dirty"],
              "imageIds": manifest["imageIds"], "checks": [], "gitops": "not tested",
              "networkPolicy": "not enforced/tested", "paidApis": False}
    forwards = []
    started = False
    with tempfile.TemporaryDirectory(prefix=cluster + "-") as directory:
        temp = Path(directory)
        kubeconfig = temp / "kubeconfig"
        kube = ["kubectl", "--kubeconfig", kubeconfig, "--context", "kind-" + cluster]
        nk = kube + ["--namespace", NAMESPACE]

        def apply(resources):
            data = yaml.safe_dump_all(resources)
            run(kube + ["apply", "--dry-run=server", "--validate=strict", "-f", "-"], data=data)
            run(kube + ["apply", "-f", "-"], data=data)

        def secret(name, values):
            # Never emit values or put runtime secrets in a tracked file.
            apply([{"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": NAMESPACE},
                    "type": "Opaque", "stringData": values}])

        def sql(owner, statement, *, host=None, check=True):
            script = ('MYSQL_PWD="$MYSQL_PASSWORD" mysql --batch --skip-column-names '
                      '-h "$1" -u "$MYSQL_USER" "$MYSQL_DATABASE"')
            return run(nk + ["exec", "-i", owner + "-mysql-0", "--", "sh", "-c", script, "sh", host or "127.0.0.1"],
                       data=statement + ";\n", capture=check, check=check)

        def pod_uid(service):
            items = json.loads(run(nk + ["get", "pods", "-l", "app.kubernetes.io/name=" + service,
                                         "-o", "json"], capture=True))["items"]
            ready = [p for p in items if not p["metadata"].get("deletionTimestamp")
                     and any(c.get("type") == "Ready" and c["status"] == "True" for c in p["status"].get("conditions", []))]
            return ready[0]["metadata"]["uid"] if len(ready) == 1 else None

        def forward(service, port):
            local = free_port()
            process = subprocess.Popen([str(p) for p in nk + ["port-forward", "--address=127.0.0.1",
                                         "service/" + service, f"{local}:{port}"]],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            forwards.append(process)
            return "http://127.0.0.1:" + str(local)

        def get_json(url, token=None):
            import urllib.error
            import urllib.request
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            request = urllib.request.Request(url, headers={"Accept": "application/json"})
            if token:
                request.add_header("Authorization", "Bearer " + token)
            try:
                with opener.open(request, timeout=15) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, None

        def passed(label):
            print("PASS: " + label, flush=True)
            report["checks"].append(label)

        try:
            started = True
            run([args.kind, "create", "cluster", "--name", cluster, "--config", ROOT / "kind/local.yaml",
                 "--kubeconfig", kubeconfig, "--wait", "180s"], timeout=300)
            for name, image in images.items():
                print("Loading " + name, flush=True)
                archive = temp / (name + ".tar")
                run(["docker", "image", "save", "--platform", platform, "--output", archive, image])
                run([args.kind, "load", "image-archive", archive, "--name", cluster])
                archive.unlink()
            apply([{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE}}])
            passwords = {owner: secrets.token_urlsafe(30) for owner in ("core", "catalog", "ops")}
            catalog_token, document_token, assistant_token = (secrets.token_hex(32) for _ in range(3))
            for owner, password in passwords.items():
                secret(owner + "-mysql-runtime", {"MYSQL_PASSWORD": password, "MYSQL_ROOT_PASSWORD": secrets.token_urlsafe(30)})
            secret("core-runtime", {"SPRING_DATASOURCE_PASSWORD": passwords["core"],
                   "ACCOUNT_JWT_SECRET": secrets.token_hex(32), "CATALOG_INTERNAL_TOKEN": catalog_token,
                   "DOCUMENT_INTERNAL_TOKEN": document_token, "ASSISTANT_TOOLS_TOKEN": assistant_token})
            secret("catalog-runtime", {"SPRING_DATASOURCE_PASSWORD": passwords["catalog"],
                   "CATALOG_INTERNAL_TOKEN": catalog_token, "DATA_GO_KR_SERVICE_KEY": "compose%2Bverification%2Fkey%3D",
                   "KSTARTUP_API_KEY": "compose%2Bstartup%2Fverification%3D", "MSIT_API_KEY": "compose%2Bnotice%2Fverification%3D",
                   "CNTRADE_NOTICE_API_KEY": "compose%2Bnotice%2Fverification%3D"})
            secret("ai-runtime", {"OPENAI_API_KEY": "local-fixture-never-sent", "DOCUMENT_INTERNAL_TOKEN": document_token,
                                   "ASSISTANT_TOOLS_TOKEN": assistant_token})
            secret("ops-runtime", {"DJANGO_SECRET_KEY": secrets.token_hex(32), "DB_PASSWORD": passwords["ops"]})
            for name, port in STUBS.items():
                labels = {"app.kubernetes.io/name": name}
                apply([
                    {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "namespace": NAMESPACE},
                     "spec": {"replicas": 1, "selector": {"matchLabels": labels}, "template": {"metadata": {"labels": labels},
                              "spec": {"automountServiceAccountToken": False, "containers": [{"name": name, "image": images[name],
                                       "imagePullPolicy": "Never", "resources": {"requests": {"cpu": "10m", "memory": "16Mi"},
                                       "limits": {"cpu": "200m", "memory": "96Mi"}}, "ports": [{"containerPort": port}]}]}}}},
                    {"apiVersion": "v1", "kind": "Service", "metadata": {"name": name, "namespace": NAMESPACE},
                     "spec": {"selector": labels, "ports": [{"port": port, "targetPort": port}]}}
                ])
            data_resources = list(yaml.safe_load_all(run([args.helm, "template", "local-data", ROOT / "charts/govbiz-local-data",
                                 "--namespace", NAMESPACE, "--set", "allowDisposableData=true", "--set-string",
                                 "stores.elasticsearch.image=" + images["elasticsearch"]], capture=True)))
            apply(data_resources)
            for name in ("core-mysql", "catalog-mysql", "ops-mysql", "elasticsearch", "redis", "qdrant"):
                run(nk + ["rollout", "status", "statefulset/" + name, "--timeout=400s"])
            service_resources = {}
            for service in ("ai-service", "catalog-service", "core-service", "ops-service"):
                resources = render(service, args.helm)
                require(not policy_errors(service, resources), "Invalid service policy: " + service)
                deployment = next(r for r in resources if r["kind"] == "Deployment")
                container = deployment["spec"]["template"]["spec"]["containers"][0]
                container["image"] = images[service]
                if service == "catalog-service":
                    overrides = {"BIZINFO_API_BASE_URL": "http://bizinfo-stub:8001", "KSTARTUP_API_BASE_URL": "http://kstartup-stub:8003",
                                 "MSIT_API_BASE_URL": "http://public-notices-stub:8004", "CNTRADE_NOTICE_API_BASE_URL": "http://public-notices-stub:8004",
                                 "SUPPORT_PROGRAM_INDEX_ENABLED": "true", "SUPPORT_PROGRAM_INDEX_FIXED_DELAY": "PT3S"}
                    for source in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"):
                        overrides.update({source + "_SYNC_ENABLED": "true", source + "_SYNC_INITIAL_DELAY": "PT0S", source + "_SYNC_FIXED_DELAY": "PT10S"})
                    container["env"] = [e for e in container["env"] if e["name"] not in overrides]
                    container["env"].extend({"name": k, "value": v} for k, v in overrides.items())
                service_resources[service] = resources
                apply(resources)
                run(nk + ["rollout", "status", "deployment/" + service, "--timeout=500s"])
            urls = {s: forward(s, 8080 if s == "core-service" else 8081 if s == "catalog-service" else 8000) for s in SERVICES}
            paths = {"core-service": "/api/v1/health", "catalog-service": "/readiness", "ai-service": "/internal/v1/health", "ops-service": "/api/v1/health/ready"}
            for service in SERVICES:
                wait_http(urls[service] + paths[service], 200)
            passed("four real services with independent DBs are healthy")
            endpoint = urls["catalog-service"] + "/internal/v1/catalog/snapshots/BIZINFO"
            require(get_json(endpoint)[0] == 401 and get_json(endpoint, "wrong")[0] == 401, "Catalog accepted invalid credentials")
            passed("Catalog rejects absent/wrong internal credentials")
            baseline_query = "SELECT source_code,COUNT(*) FROM support_program WHERE is_source_present=TRUE GROUP BY source_code ORDER BY source_code"
            expected = {"BIZINFO": 27, "KSTARTUP": 2, "MSIT": 11, "CNTRADE_NOTICE": 2}
            def complete_projection():
                rows = sql("core", baseline_query).strip().splitlines()
                return {line.split()[0]: int(line.split()[1]) for line in rows} == expected
            wait_for("42 fixture programs reach Core over authenticated Catalog HTTP", complete_projection)
            passed("Catalog→Core snapshot projection: four sources, 42 programs")
            denied = subprocess.run([str(p) for p in nk + ["exec", "core-mysql-0", "--", "sh", "-c",
                                    'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h catalog-mysql -u "$MYSQL_USER" -e "SELECT 1"']],
                                    capture_output=True, text=True, timeout=30)
            require(denied.returncode != 0 and "1045" in denied.stderr and "Access denied" in denied.stderr,
                    "Expected an explicit cross-database authentication denial, not a network error")
            passed("Core DB credentials are rejected by Catalog DB")
            baseline = sql("core", baseline_query)
            original_uids = {s: pod_uid(s) for s in SERVICES}
            require(all(original_uids.values()), "Missing healthy application Pod")
            # A rollout marker exercises one release without inventing a second code version.
            changed = render("ai-service", args.helm, ["--set-string", "env.GOVBIZ_ROLLOUT_PROBE=v2"])
            next(r for r in changed if r["kind"] == "Deployment")["spec"]["template"]["spec"]["containers"][0]["image"] = images["ai-service"]
            apply(changed)
            run(nk + ["rollout", "status", "deployment/ai-service", "--timeout=300s"])
            require(pod_uid("ai-service") != original_uids["ai-service"], "AI Pod did not change")
            require(all(pod_uid(s) == original_uids[s] for s in SERVICES if s != "ai-service"), "Other service rolled with AI")
            apply(service_resources["ai-service"])
            run(nk + ["rollout", "status", "deployment/ai-service", "--timeout=300s"])
            passed("AI-only configuration rollout and revert leave other service Pods unchanged")
            run(nk + ["scale", "deployment/catalog-service", "--replicas=0"])
            time.sleep(25)
            require(sql("core", baseline_query) == baseline, "Catalog outage changed Core data")
            status, catalog = get_json(urls["core-service"] + "/api/v1/support-programs/catalog?sourceCode=KSTARTUP&status=OPEN")
            require(status == 200 and catalog["total"] == 2, "Core catalog unavailable during outage")
            apply(service_resources["catalog-service"])
            run(nk + ["rollout", "status", "deployment/catalog-service", "--timeout=400s"])
            passed("Catalog outage preserves Core public catalog and data")
            sql("ops", "CREATE TABLE msa_restore_probe (id INT PRIMARY KEY, note VARCHAR(100)) CHARACTER SET utf8mb4; INSERT INTO msa_restore_probe VALUES (1,'포트폴리오 복구 검증')")
            dump = run(nk + ["exec", "ops-mysql-0", "--", "sh", "-c",
                       'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --no-tablespaces --single-transaction -u "$MYSQL_USER" "$MYSQL_DATABASE" msa_restore_probe'], capture=True)
            sql("ops", "DELETE FROM msa_restore_probe WHERE id=1")
            sql("ops", dump)
            require("포트폴리오 복구 검증" in sql("ops", "SELECT note FROM msa_restore_probe WHERE id=1"), "Fixture table restore failed")
            run(nk + ["delete", "pod", "ops-mysql-0", "--wait=true"])
            run(nk + ["rollout", "status", "statefulset/ops-mysql", "--timeout=300s"])
            require("포트폴리오 복구 검증" in sql("ops", "SELECT note FROM msa_restore_probe WHERE id=1"), "PVC data lost")
            passed("Ops fixture-table backup/restore and database Pod recreation preserve UTF-8 data")
            if args.gitops_interactive:
                print("LOCAL_MSA_CHECKS_PASSED: commit/push reviewed changes before entering Git revisions.", flush=True)
                from gitops_msa import validate_revisions
                args.gitops_revisions = input("Enter pushed BASE_SHA AI_ONLY_SHA (Ctrl-C cleans this cluster): ").split()
                validate_revisions(args.gitops_revisions)
            if args.gitops_revisions:
                from gitops_msa import verify
                report["gitops"] = verify(kube, cluster, images, args.kind, temp, args.gitops_revisions)
                passed("Argo CD fetches pushed Git revisions and automatically rolls/reverts only AI")
            report["status"] = "passed"
        except BaseException:
            report["status"] = "failed"
            if started:
                run(nk + ["get", "pods", "-o", "wide"], check=False)
                run(nk + ["get", "events", "--sort-by=.lastTimestamp"], check=False)
            raise
        finally:
            for process in forwards:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
            if started:
                run([args.kind, "delete", "cluster", "--name", cluster], timeout=120)
            with args.report.open("x") as file:
                json.dump(report, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
