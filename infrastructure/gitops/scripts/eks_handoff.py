"""Carry the deployed GovBiz configuration and cold PVC data to a NEW EKS cluster.

No AWS calls, rollout, source scaling, registry publication or database migration.
Reuse ops_snapshot's authenticated encryption; never export cluster credentials.
"""

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "llmops"))
import ops_snapshot as snapshot

NAMESPACES = ("govbiz-msa", "govbiz-evaluation", "govbiz-observability")
HELPER_IMAGE = (
    "prefecthq/prefect:3.8.6-python3.12@sha256:"
    "ec9e58deaf30002dd65ebb755ca3d9eb5f169902882abf18c79261a4aa95bfe3"
)
CHUNK_SIZE = 16 * 1024 * 1024
LABEL = "govbiz.io/handoff"
FORMAT = "govbiz-eks-handoff-v1"
POOL_LABEL = "govbiz.io/workload-pool"


def require(condition, message):
    if not condition:
        raise snapshot.SnapshotError(message)


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=False)
    if os.name == "nt":
        # Restrict the directory BEFORE writing any key or decrypted Secret.
        sid = snapshot.run(["whoami", "/user", "/fo", "csv", "/nh"]).decode()
        sid = re.search(r"S-1-5-[0-9-]+", sid).group()
        snapshot.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"]
        )


def key_at(path):
    if os.name != "nt":
        return snapshot.key_bytes(path)
    require(
        path.is_file() and not path.is_symlink(), "Key must be a regular private file"
    )
    value = path.read_bytes()
    require(re.fullmatch(rb"[a-f0-9]{64}\n?", value), "Invalid key format")
    return value


def write_json(path, value):
    snapshot.exclusive(
        path, json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    )


def clean(resource):
    result = {
        k: copy.deepcopy(v)
        for k, v in resource.items()
        if k not in {"status", "metadata"}
    }
    metadata = resource["metadata"]
    result["metadata"] = {
        k: metadata[k] for k in ("name", "namespace") if k in metadata
    }
    if metadata.get("labels"):
        result["metadata"]["labels"] = {
            k: v
            for k, v in metadata["labels"].items()
            if not k.startswith(
                ("argocd.argoproj.io/", "app.kubernetes.io/managed-by", "helm.sh/")
            )
        }
    return result


def items(values):
    return {"apiVersion": "v1", "kind": "List", "items": values}


def identity(resource):
    return resource["metadata"]["namespace"], resource["metadata"]["name"]


def referenced_claims(resources):
    selected = set()
    for resource in resources:
        if resource["kind"] == "Pod":
            selected.update(
                (
                    resource["metadata"]["namespace"],
                    v["persistentVolumeClaim"]["claimName"],
                )
                for v in resource["spec"].get("volumes", [])
                if "persistentVolumeClaim" in v
            )
    # Retain historical collection receipts even when their completed Job is gone.
    if any(
        r["kind"] == "PersistentVolumeClaim"
        and identity(r) == ("govbiz-msa", "catalog-sync-receipts")
        for r in resources
    ):
        selected.add(("govbiz-msa", "catalog-sync-receipts"))
    return sorted(selected)


def kubectl(args):
    return [args.kubectl, "--kubeconfig", str(args.kubeconfig), "--request-timeout=30s"]


def get(kube, *args):
    return json.loads(snapshot.run(kube + list(args) + ["-o", "json"]))


def collect(kube, source_mode="argocd"):
    resources = []
    namespaces = {}
    for ns in NAMESPACES:
        namespaces[ns] = get(kube, "get", "namespace", ns)["metadata"]["uid"]
        resources += get(
            kube, "-n", ns, "get", "deploy,sts,pvc,pods,svc,cm,secret,networkpolicy"
        )["items"]
        require(
            not get(kube, "-n", ns, "get", "cronjobs")["items"],
            "Suspend and review CronJobs before handoff",
        )
    # Only explicitly referenced application Secrets, never service-account,
    # Helm history, kubeconfig or Argo repository credentials.
    needed = set()
    for r in resources:
        if r["kind"] not in {"Deployment", "StatefulSet"}:
            continue
        pod = r["spec"]["template"]["spec"]
        for c in pod.get("containers", []) + pod.get("initContainers", []):
            for e in c.get("env", []):
                ref = e.get("valueFrom", {}).get("secretKeyRef")
                if ref:
                    needed.add((r["metadata"]["namespace"], ref["name"]))
            for e in c.get("envFrom", []):
                if "secretRef" in e:
                    needed.add((r["metadata"]["namespace"], e["secretRef"]["name"]))
        for v in pod.get("volumes", []):
            if "secret" in v:
                needed.add((r["metadata"]["namespace"], v["secret"]["secretName"]))
        for ref in pod.get("imagePullSecrets", []):
            needed.add((r["metadata"]["namespace"], ref["name"]))
    resources = [r for r in resources if r["kind"] != "Secret" or identity(r) in needed]
    require(
        all(r.get("type") != "kubernetes.io/service-account-token" for r in resources),
        "Service account token is not portable",
    )
    require(
        needed == {identity(r) for r in resources if r["kind"] == "Secret"},
        "A required application Secret is missing",
    )
    require(source_mode in {"argocd", "manifests"}, "Unknown source mode")
    if source_mode == "manifests":
        api = snapshot.run(
            kube + ["api-resources", "--api-group=argoproj.io", "-o", "name"]
        )
        apps = (
            get(kube, "get", "applications", "-A")["items"]
            if b"applications.argoproj.io" in api.splitlines()
            else []
        )
        require(
            not any(
                a["spec"]["destination"].get("namespace") in NAMESPACES for a in apps
            ),
            "Use argocd source mode for Argo-managed workloads",
        )
        apps = []
    else:
        apps = get(kube, "-n", "argocd", "get", "applications")["items"]
    apps = [a for a in apps if a["spec"]["destination"]["namespace"] in NAMESPACES]
    for a in apps:
        require(
            re.fullmatch(r"[0-9a-f]{40}", a["spec"]["source"]["targetRevision"]),
            "Pin every Application to a Git SHA",
        )
        policy = a["spec"].get("syncPolicy", {}).get("automated", {})
        require(
            not policy or policy.get("enabled") is False,
            "Disable automatic sync before cold backup",
        )
        require(not a.get("operation"), "Wait for the active Argo operation to finish")
    project_names = {a["spec"]["project"] for a in apps}
    projects = [
        p
        for p in (
            get(kube, "-n", "argocd", "get", "appprojects")["items"] if apps else []
        )
        if p["metadata"]["name"] in project_names
    ]
    claims = referenced_claims(resources)
    require(
        set(claims)
        <= {identity(r) for r in resources if r["kind"] == "PersistentVolumeClaim"},
        "A source PVC is missing",
    )
    return {
        "format": FORMAT,
        "sourceMode": source_mode,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "namespaces": namespaces,
        "resources": resources,
        "applications": apps,
        "projects": projects,
        "claims": claims,
    }


def capture(args):
    config = collect(kubectl(args), args.source_mode)
    if args.source_mode == "manifests":
        manifest_inventory(config)
    require(not args.key_file.exists(), "Choose a new key path")
    require(not args.output.exists(), "Choose a new bundle directory")
    require(
        not args.key_file.resolve().is_relative_to(args.output.resolve()),
        "Keep the key outside the bundle",
    )
    private_directory(args.output)
    private_directory(args.key_file.parent)
    key = secrets.token_hex(32).encode() + b"\n"
    snapshot.exclusive(args.key_file, key)
    snapshot.exclusive(args.output / "configuration.enc", snapshot.seal(config, key))
    write_json(
        args.output / "summary.json",
        {
            "format": FORMAT,
            "capturedAt": config["capturedAt"],
            "scope": "configuration-only",
            "sourceMode": config["sourceMode"],
            "claims": config["claims"],
            "revisions": {
                a["metadata"]["name"]: a["spec"]["source"]["targetRevision"]
                for a in config["applications"]
            },
        },
    )
    if args.source_mode == "manifests":
        write_json(args.output / "image-inventory.json", manifest_inventory(config))
    emit(
        "CAPTURED",
        claims=len(config["claims"]),
        applications=len(config["applications"]),
    )


def read_config(bundle, key):
    value = snapshot.open_payload((bundle / "configuration.enc").read_bytes(), key)
    require(value.get("format") == FORMAT, "Unsupported handoff format")
    return value


def stopped(kube, config, *, source):
    for ns in NAMESPACES:
        namespace = get(kube, "get", "namespace", ns)
        same = namespace["metadata"]["uid"] == config["namespaces"][ns]
        require(
            same == source,
            "Source identity mismatch or restore targets the original cluster",
        )
        workloads = get(kube, "-n", ns, "get", "deploy,sts")["items"]
        require(
            all(w["spec"].get("replicas", 1) == 0 for w in workloads),
            "Stop application and storage workloads first",
        )
        pods = get(kube, "-n", ns, "get", "pods")["items"]
        require(
            all(p["status"].get("phase") in {"Succeeded", "Failed"} for p in pods),
            "Wait for all source/destination writers to exit",
        )
        require(
            not get(kube, "-n", ns, "get", "cronjobs")["items"],
            "CronJobs are not supported during cold copy",
        )


def helper(ns, claims, node, name, *, readonly, pool=None):
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"namespace": ns, "name": name, "labels": {LABEL: name}},
        "spec": {
            "restartPolicy": "Never",
            "activeDeadlineSeconds": 7200,
            "automountServiceAccountToken": False,
            "terminationGracePeriodSeconds": 5,
            "nodeSelector": {POOL_LABEL: pool}
            if pool
            else {"kubernetes.io/hostname": node},
            "securityContext": {
                "runAsUser": 0,
                "runAsGroup": 0,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [
                {
                    "name": "copy",
                    "image": HELPER_IMAGE,
                    "command": ["python", "-B", "-c", "import time; time.sleep(7200)"],
                    "resources": {
                        "requests": {"cpu": "50m", "memory": "64Mi"},
                        "limits": {"cpu": "1", "memory": "256Mi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": True,
                        "allowPrivilegeEscalation": False,
                        "capabilities": {
                            "drop": ["ALL"],
                            "add": ["DAC_READ_SEARCH"]
                            if readonly
                            else ["CHOWN", "DAC_OVERRIDE", "FOWNER"],
                        },
                    },
                    "volumeMounts": [
                        {
                            "name": f"v{i}",
                            "mountPath": f"/volumes/{i}",
                            "readOnly": readonly,
                        }
                        for i, _ in enumerate(claims)
                    ],
                }
            ],
            "volumes": [
                {
                    "name": f"v{i}",
                    "persistentVolumeClaim": {"claimName": c, "readOnly": readonly},
                }
                for i, c in enumerate(claims)
            ],
        },
    }


def archive_stream(command, directory, key):
    directory.mkdir()
    hashes, digest, total = [], hashlib.sha256(), 0
    with (
        tempfile.TemporaryFile() as errors,
        subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors) as proc,
    ):
        try:
            while raw := proc.stdout.read(CHUNK_SIZE):
                digest.update(raw)
                total += len(raw)
                encrypted = snapshot.seal({"data": base64.b64encode(raw).decode()}, key)
                filename = f"{len(hashes):06d}.enc"
                snapshot.exclusive(directory / filename, encrypted)
                hashes.append(
                    {"file": filename, "sha256": hashlib.sha256(encrypted).hexdigest()}
                )
            code = proc.wait(timeout=60)
            errors.seek(0)
            diagnostic = errors.read(16384)
            reason = next(
                (
                    s
                    for s in (
                        b"deadline exceeded",
                        b"unexpected EOF",
                        b"file changed as we read it",
                        b"Permission denied",
                        b"Cannot open",
                    )
                    if s in diagnostic
                ),
                b"private output withheld",
            ).decode()
            require(
                code == 0,
                f"Source tar failed ({code}, {reason}); incomplete backup is unusable",
            )
        finally:
            if proc.poll() is None:
                proc.kill()
    return {"chunks": hashes, "bytes": total, "sha256": digest.hexdigest()}


def restore_stream(command, directory, manifest, key):
    # Authenticate EVERY chunk and the complete stream before touching a PVC.
    for apply in (False, True):
        digest, total = hashlib.sha256(), 0
        proc = (
            subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if apply
            else None
        )
        try:
            for chunk in manifest["chunks"]:
                require(
                    re.fullmatch(r"[0-9]{6}\.enc", chunk["file"]), "Invalid chunk path"
                )
                encrypted = (directory / chunk["file"]).read_bytes()
                require(
                    hashlib.sha256(encrypted).hexdigest() == chunk["sha256"],
                    "Damaged backup chunk",
                )
                raw = base64.b64decode(
                    snapshot.open_payload(encrypted, key)["data"], validate=True
                )
                digest.update(raw)
                total += len(raw)
                if proc:
                    proc.stdin.write(raw)
            require(
                total == manifest["bytes"] and digest.hexdigest() == manifest["sha256"],
                "Incomplete backup stream",
            )
            if proc:
                proc.stdin.close()
                require(
                    proc.wait(timeout=180) == 0,
                    "Target tar failed; retain the original and use a NEW empty PVC",
                )
        finally:
            if proc and proc.poll() is None:
                proc.kill()
                proc.wait()


def cold_copy(args, *, restore):
    key = key_at(args.key_file)
    config = read_config(args.bundle, key)
    use_pools = getattr(args, "pool_placement", False)
    require(
        not use_pools or (restore and config.get("sourceMode") == "manifests"),
        "Pool restore requires a manifests source bundle",
    )
    require(use_pools or args.node, "Supply --node or use --pool-placement for restore")
    if use_pools:
        manifest_inventory(config)
    kube = kubectl(args)
    stopped(kube, config, source=not restore)
    if restore:
        manifest = snapshot.open_payload((args.bundle / "backup.enc").read_bytes(), key)
        require(
            manifest.get("format") == FORMAT and manifest["claims"] == config["claims"],
            "Backup/configuration mismatch",
        )
        require(
            manifest.get("archive") == "tar+gzip", "Unsupported volume archive encoding"
        )
    else:
        require(
            not (args.bundle / "volumes").exists(),
            "Use a fresh capture directory for each backup attempt",
        )
        (args.bundle / "volumes").mkdir()
        manifest = {
            "format": FORMAT,
            "archive": "tar+gzip",
            "claims": config["claims"],
            "volumes": {},
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    for ns in NAMESPACES:
        claims = [c for n, c in config["claims"] if n == ns]
        name = "govbiz-handoff-" + secrets.token_hex(4)
        if not claims:
            continue
        pool = workload_pool(ns, "") if use_pools else None
        pod = helper(ns, claims, args.node, name, readonly=not restore, pool=pool)
        created = None
        try:
            created = json.loads(
                snapshot.run(
                    kube + ["create", "-f", "-", "-o", "json"],
                    data=json.dumps(pod).encode(),
                )
            )
            snapshot.run(
                kube
                + [
                    "-n",
                    ns,
                    "wait",
                    "--for=condition=Ready",
                    "pod/" + name,
                    "--timeout=240s",
                ],
                timeout=260,
            )
            # A multi-GB tar must not inherit the short API discovery timeout.
            # The helper's activeDeadlineSeconds still bounds its lifetime.
            command = kube + [
                "--request-timeout=0",
                "-n",
                ns,
                "exec",
                "-i",
                name,
                "-c",
                "copy",
                "--",
            ]
            for i, claim in enumerate(claims):
                folder = args.bundle / "volumes" / (ns + "__" + claim)
                emit(
                    "RESTORING" if restore else "BACKING_UP", namespace=ns, claim=claim
                )
                if restore:
                    # ext4's empty lost+found is allowed, no existing application files.
                    check = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert all(x.name=='lost+found' and x.is_dir() and not any(x.iterdir()) for x in p.iterdir())"
                    snapshot.run(command + ["python", "-c", check, f"/volumes/{i}"])
                    restore_stream(
                        command
                        + [
                            "tar",
                            "--numeric-owner",
                            "--same-owner",
                            "--same-permissions",
                            "-xzpf",
                            "-",
                            "-C",
                            f"/volumes/{i}",
                        ],
                        folder,
                        manifest["volumes"][ns + "/" + claim],
                        key,
                    )
                else:
                    manifest["volumes"][ns + "/" + claim] = archive_stream(
                        command
                        + [
                            "tar",
                            "--numeric-owner",
                            "--sparse",
                            "-czpf",
                            "-",
                            "-C",
                            f"/volumes/{i}",
                            ".",
                        ],
                        folder,
                        key,
                    )
        finally:
            if created:
                # Delete only the Pod created by this invocation, never a source PVC.
                live = get(kube, "-n", ns, "get", "pod", name)
                require(
                    live["metadata"]["uid"] == created["metadata"]["uid"],
                    "Helper identity changed",
                )
                snapshot.run(
                    kube
                    + ["-n", ns, "delete", "pod", name, "--wait=true", "--timeout=60s"],
                    timeout=80,
                )
    if not restore:
        manifest["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        snapshot.exclusive(args.bundle / "backup.enc", snapshot.seal(manifest, key))
        write_json(
            args.bundle / "backup-completed.json",
            {
                "completedAt": manifest["completedAt"],
                "claims": len(config["claims"]),
                "bytes": sum(v["bytes"] for v in manifest["volumes"].values()),
            },
        )
    emit(
        "RESTORED" if restore else "BACKUP_COMPLETED",
        claims=len(config["claims"]),
        workloadsStarted=False,
    )


def image_digest(image_id):
    value = image_id.removeprefix("docker-pullable://")
    require(
        "@sha256:" in value,
        "Registry digest missing; supply the published Elasticsearch digest",
    )
    return value


def destination(config, node, elasticsearch_image):
    require(
        re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", elasticsearch_image),
        "Elasticsearch must be published with an immutable digest",
    )
    require(
        node and "control-plane" not in node, "Supply the destination EKS node hostname"
    )
    resources = config["resources"]
    claims = {tuple(c) for c in config["claims"]}
    storage, dependencies, namespaces, pvcs = [], [], [], []
    for ns in NAMESPACES:
        namespaces.append(
            {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns}}
        )
    for r in resources:
        kind, (ns, name) = r["kind"], identity(r)
        if kind == "PersistentVolumeClaim" and (ns, name) in claims:
            # local-path does not enforce its advertised 1Gi limit. Give the
            # restored EBS filesystems explicit headroom; operators may increase it.
            original_size = r["spec"]["resources"]["requests"]["storage"]
            require(
                re.fullmatch(r"[0-9]+Gi", original_size),
                "Review non-Gi storage requests manually",
            )
            minimum = 30 if name.startswith(("clickhouse", "minio")) else 10
            storage_size = f"{max(minimum, int(original_size[:-2]))}Gi"
            pvcs.append(
                {
                    "apiVersion": "v1",
                    "kind": kind,
                    "metadata": {"name": name, "namespace": ns},
                    "spec": {
                        "storageClassName": "govbiz-ebs-gp3",
                        "accessModes": ["ReadWriteOnce"],
                        "resources": {"requests": {"storage": storage_size}},
                    },
                }
            )
        elif kind == "Secret" or (kind == "ConfigMap" and name != "kube-root-ca.crt"):
            dependencies.append(clean(r))
        elif kind == "StatefulSet" and ns == "govbiz-msa":
            row = clean(r)
            spec = row["spec"]
            spec["replicas"] = 0
            spec["persistentVolumeClaimRetentionPolicy"] = {
                "whenDeleted": "Retain",
                "whenScaled": "Retain",
            }
            pod = spec["template"]["spec"]
            pod.pop("nodeName", None)
            pod["nodeSelector"] = {"kubernetes.io/hostname": node}
            for template in spec.pop("volumeClaimTemplates", []):
                claim = template["metadata"]["name"] + "-" + name + "-0"
                require((ns, claim) in claims, "Missing StatefulSet volume")
                pod.setdefault("volumes", []).append(
                    {
                        "name": template["metadata"]["name"],
                        "persistentVolumeClaim": {"claimName": claim},
                    }
                )
            running = next(
                p
                for p in resources
                if p["kind"] == "Pod" and identity(p) == (ns, name + "-0")
            )
            statuses = {c["name"]: c for c in running["status"]["containerStatuses"]}
            for container in pod["containers"]:
                container["image"] = (
                    elasticsearch_image
                    if name == "elasticsearch"
                    else image_digest(statuses[container["name"]]["imageID"])
                )
                container["imagePullPolicy"] = "IfNotPresent"
            storage.append(row)
        elif (
            kind == "Service"
            and ns == "govbiz-msa"
            and name
            in {
                "core-mysql",
                "catalog-mysql",
                "ops-mysql",
                "elasticsearch",
                "qdrant",
                "redis",
                "rabbitmq",
            }
        ):
            row = clean(r)
            for field in (
                "clusterIP",
                "clusterIPs",
                "ipFamilies",
                "ipFamilyPolicy",
                "healthCheckNodePort",
            ):
                if row["spec"].get(field) != "None":
                    row["spec"].pop(field, None)
            storage.append(row)
    apps = [clean(a) for a in config["applications"]]
    for app in apps:
        spec = app["spec"]
        spec["destination"]["server"] = "https://kubernetes.default.svc"
        spec["destination"].pop("name", None)
        spec["syncPolicy"] = {
            "automated": {"enabled": False, "prune": False, "selfHeal": False},
            "syncOptions": ["FailOnSharedResource=true"],
        }
        helm = spec["source"]["helm"]
        helm.pop("kubeVersion", None)
        values = helm.setdefault("valuesObject", {})
        if "node" in values:
            values["node"] = node
        if "node" in values.get("storage", {}):
            values["storage"]["node"] = node
        if values.get("serviceName") == "core-service":
            values["env"]["ACCOUNT_DEV_LOGIN_ENABLED"] = "false"
            values["env"]["APP_CORS_ALLOWED_ORIGIN"] = "http://localhost:18173"
        if values.get("serviceName") == "ops-service":
            values["env"]["OPS_WEB_URL"] = "http://localhost:18173"
    return {
        "00-namespaces.json": items(namespaces),
        "10-claims.json": items(pvcs),
        "20-private-dependencies.json": items(dependencies),
        "30-data-stopped.json": items(storage),
        "40-projects.json": items([clean(p) for p in config["projects"]]),
        "50-applications.json": items(apps),
    }


def workload_pool(namespace, name):
    # One node per pool; keep all namespace PVCs and their consumers together.
    # AI/web have no PVCs and leave more CPU headroom on the application node.
    return (
        "observability"
        if namespace == "govbiz-observability"
        or (namespace == "govbiz-msa" and name in {"ai-service", "web"})
        else "application"
    )


def manifest_inventory(config):
    """Validate the current single-replica deployment and list every image to mirror."""
    require(
        config.get("sourceMode") == "manifests", "A manifests source bundle is required"
    )
    require(
        not config["applications"], "Argo applications cannot use manifest placement"
    )
    images = {}
    claims = {tuple(c) for c in config["claims"]}
    for r in config["resources"]:
        if r["kind"] not in {"Deployment", "StatefulSet"}:
            continue
        ns, name = identity(r)
        require(
            r["spec"].get("replicas", 1) in {0, 1},
            "Review multi-replica workloads before handoff",
        )
        pod = r["spec"]["template"]["spec"]
        require(
            pod.get("serviceAccountName", "default") == "default",
            "Export custom service account/RBAC before handoff",
        )
        require(
            not pod.get("affinity") and not pod.get("topologySpreadConstraints"),
            "Review custom scheduling constraints before handoff",
        )
        require(
            not pod.get("hostNetwork")
            and not any("hostPath" in v for v in pod.get("volumes", [])),
            "Host-bound workloads are not portable",
        )
        mounted = [
            v["persistentVolumeClaim"]["claimName"]
            for v in pod.get("volumes", [])
            if "persistentVolumeClaim" in v
        ]
        mounted += [
            t["metadata"]["name"] + "-" + name + "-0"
            for t in r["spec"].get("volumeClaimTemplates", [])
        ]
        require(
            all((ns, c) in claims for c in mounted),
            "A workload PVC is missing from the bundle",
        )
        require(
            not mounted or workload_pool(ns, name) == workload_pool(ns, ""),
            "PVC consumers must use the namespace restore pool",
        )
        for c in pod.get("containers", []) + pod.get("initContainers", []):
            image = c["image"]
            require(
                re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", image),
                "Pin all workload and init images before capture",
            )
            images.setdefault(image, []).append(f"{ns}/{name}/{c['name']}")
    require(images, "No workload images were captured")
    return {
        "images": [
            {"source": i, "consumers": sorted(v)} for i, v in sorted(images.items())
        ]
    }


def manifest_destination(config, image_map):
    """Produce stopped bootstrap manifests for the Sydney two-pool demo."""
    inventory = manifest_inventory(config)
    sources = {i["source"] for i in inventory["images"]}
    require(
        set(image_map) == sources,
        "Image map must cover every captured image, including init containers",
    )
    for target in image_map.values():
        require(
            re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", target),
            "Every destination image needs a published digest",
        )
        require(
            "govbiz-migration/" not in target,
            "Publish local migration images to a pullable registry",
        )
    dependencies, storage, apps, services, policies, pvcs, replicas = (
        [],
        [],
        [],
        [],
        [],
        [],
        [],
    )
    claims = {tuple(c) for c in config["claims"]}
    for r in config["resources"]:
        kind, (ns, name) = r["kind"], identity(r)
        if kind == "PersistentVolumeClaim" and (ns, name) in claims:
            original = r["spec"]["resources"]["requests"]["storage"]
            require(
                re.fullmatch(r"[0-9]+Gi", original),
                "Review non-Gi storage requests manually",
            )
            minimum = 30 if name.startswith(("clickhouse", "minio")) else 10
            pvcs.append(
                {
                    "apiVersion": "v1",
                    "kind": kind,
                    "metadata": {"name": name, "namespace": ns},
                    "spec": {
                        "storageClassName": "govbiz-ebs-gp3",
                        "accessModes": ["ReadWriteOnce"],
                        "resources": {
                            "requests": {
                                "storage": f"{max(minimum, int(original[:-2]))}Gi"
                            }
                        },
                    },
                }
            )
        elif kind == "Secret" or (kind == "ConfigMap" and name != "kube-root-ca.crt"):
            dependencies.append(clean(r))
        elif kind == "Service":
            row = clean(r)
            require(
                row["spec"].get("type", "ClusterIP") == "ClusterIP",
                "Review externally exposed Services before handoff",
            )
            for field in (
                "clusterIP",
                "clusterIPs",
                "ipFamilies",
                "ipFamilyPolicy",
                "healthCheckNodePort",
            ):
                if row["spec"].get(field) != "None":
                    row["spec"].pop(field, None)
            services.append(row)
        elif kind == "NetworkPolicy":
            policies.append(clean(r))
        elif kind in {"StatefulSet", "Deployment"}:
            row = clean(r)
            spec = row["spec"]
            pool = workload_pool(ns, name)
            replicas.append(
                {
                    "namespace": ns,
                    "kind": kind,
                    "name": name,
                    "replicas": spec.get("replicas", 1),
                    "pool": pool,
                }
            )
            spec["replicas"] = 0
            pod = spec["template"]["spec"]
            pod.pop("nodeName", None)
            selector = pod.setdefault("nodeSelector", {})
            selector.pop("kubernetes.io/hostname", None)
            selector[POOL_LABEL] = pool
            if kind == "StatefulSet":
                spec["persistentVolumeClaimRetentionPolicy"] = {
                    "whenDeleted": "Retain",
                    "whenScaled": "Retain",
                }
                for t in spec.pop("volumeClaimTemplates", []):
                    pod.setdefault("volumes", []).append(
                        {
                            "name": t["metadata"]["name"],
                            "persistentVolumeClaim": {
                                "claimName": t["metadata"]["name"] + "-" + name + "-0"
                            },
                        }
                    )
            # RWO consumers must not surge during later Deployment updates.
            if kind == "Deployment" and any(
                "persistentVolumeClaim" in v for v in pod.get("volumes", [])
            ):
                spec["strategy"] = {"type": "Recreate"}
            if ns == "govbiz-evaluation" and name in {
                "evaluation-runner",
                "ops-artifacts",
            }:
                # Node-group replacement can briefly have two nodes. RWO sharing
                # still needs the exact same host, not just the same pool label.
                spec["template"].setdefault("metadata", {}).setdefault("labels", {})[
                    "govbiz.io/evaluation-volume"
                ] = "shared"
                pod["affinity"] = {
                    "podAffinity": {
                        "requiredDuringSchedulingIgnoredDuringExecution": [
                            {
                                "labelSelector": {
                                    "matchLabels": {
                                        "govbiz.io/evaluation-volume": "shared"
                                    }
                                },
                                "topologyKey": "kubernetes.io/hostname",
                            }
                        ]
                    }
                }
            for c in pod.get("containers", []) + pod.get("initContainers", []):
                c["image"] = image_map[c["image"]]
                c["imagePullPolicy"] = "IfNotPresent"
                overrides = {}
                if name == "core-service":
                    overrides = {
                        "ACCOUNT_DEV_LOGIN_ENABLED": "false",
                        "APP_CORS_ALLOWED_ORIGIN": "http://localhost:18173",
                    }
                if name == "ops-service":
                    overrides["OPS_WEB_URL"] = "http://localhost:18173"
                if name in {"ops-service", "evaluation-runner"}:
                    overrides.update(
                        {
                            key: "false"
                            for key in (
                                "LLMOPS_LIVE_ENABLED",
                                "LLMOPS_RAG_LIVE_ENABLED",
                                "LLMOPS_SCHEDULES_ENABLED",
                            )
                        }
                    )
                if overrides:
                    c["env"] = [
                        e for e in c.get("env", []) if e["name"] not in overrides
                    ]
                    c["env"] += [{"name": k, "value": v} for k, v in overrides.items()]
            (storage if kind == "StatefulSet" else apps).append(row)
    require({identity(p) for p in pvcs} == claims, "A source PVC is missing")
    return {
        "00-namespaces.json": items(
            [
                {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns}}
                for ns in NAMESPACES
            ]
        ),
        "10-claims.json": items(pvcs),
        "20-private-dependencies.json": items(dependencies),
        "25-services-and-policies.json": items(services + policies),
        "30-data-stopped.json": items(storage),
        "50-workloads-stopped.json": items(apps),
        "startup-plan.json": {
            "sourceMode": "manifests",
            "workloads": replicas,
            "automaticStart": False,
        },
    }


def prepare(args):
    config = read_config(args.bundle, key_at(args.key_file))
    if config.get("sourceMode") == "manifests":
        require(
            args.pool_placement and args.image_map,
            "Use --pool-placement and --image-map for a manifests bundle",
        )
        require(
            not args.node and not args.elasticsearch_image,
            "Manifest placement uses node-pool labels and a complete image map",
        )
        manifests = manifest_destination(config, json.loads(args.image_map.read_text()))
    else:
        require(
            args.node
            and args.elasticsearch_image
            and not args.pool_placement
            and not args.image_map,
            "Argo bundles require --node and --elasticsearch-image",
        )
        manifests = destination(config, args.node, args.elasticsearch_image)
    private_directory(args.output)
    for name, value in manifests.items():
        write_json(args.output / name, value)
    emit(
        "PREPARED", directory=str(args.output), applied=False, secretsInPrivateFile=True
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("capture", "backup", "restore", "prepare"):
        p = sub.add_parser(name)
        p.add_argument("--key-file", type=Path, required=True)
        if name != "capture":
            p.add_argument("--bundle", type=Path, required=True)
        if name in {"capture", "prepare"}:
            p.add_argument("--output", type=Path, required=True)
        if name != "prepare":
            p.add_argument("--kubectl", default="kubectl")
            p.add_argument("--kubeconfig", type=Path, required=True)
        if name != "capture":
            p.add_argument("--node")
        if name == "capture":
            p.add_argument(
                "--source-mode", choices=("argocd", "manifests"), default="argocd"
            )
        if name in {"restore", "prepare"}:
            p.add_argument("--pool-placement", action="store_true")
        if name == "prepare":
            p.add_argument("--elasticsearch-image")
            p.add_argument("--image-map", type=Path)
    args = parser.parse_args()
    if args.command == "capture":
        capture(args)
    elif args.command == "prepare":
        prepare(args)
    else:
        cold_copy(args, restore=args.command == "restore")


if __name__ == "__main__":
    try:
        main()
    except (
        snapshot.SnapshotError,
        OSError,
        ValueError,
        KeyError,
        StopIteration,
        subprocess.SubprocessError,
    ) as error:
        # Never echo private subprocess output, decrypted configuration or key material.
        emit(
            "FAILED",
            errorType=type(error).__name__,
            detail=str(error)
            if isinstance(error, snapshot.SnapshotError)
            else "Private operation failed; source data was not deleted",
        )
        raise SystemExit(1) from None
