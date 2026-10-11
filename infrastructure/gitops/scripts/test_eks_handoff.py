"""Portable deployment inputs and actual authenticated backup stream round trips."""

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import eks_handoff as handoff
import yaml


def resource(kind, name, namespace="govbiz-msa", **fields):
    return {
        "apiVersion": "v1",
        "kind": kind,
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": "original",
            "resourceVersion": "12",
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": "PRIVATE"
            },
        },
        **fields,
    }


def configuration():
    claim = resource(
        "PersistentVolumeClaim",
        "data-core-mysql-0",
        spec={
            "volumeName": "source-only",
            "resources": {"requests": {"storage": "1Gi"}},
        },
    )
    store = resource(
        "StatefulSet",
        "core-mysql",
        spec={
            "replicas": 1,
            "serviceName": "core-mysql",
            "volumeClaimTemplates": [{"metadata": {"name": "data"}}],
            "template": {
                "spec": {
                    "nodeName": "source-control-plane",
                    "containers": [
                        {
                            "name": "mysql",
                            "image": "mysql:8.4",
                            "imagePullPolicy": "Never",
                        }
                    ],
                }
            },
        },
    )
    pod = resource(
        "Pod",
        "core-mysql-0",
        spec={
            "volumes": [
                {"persistentVolumeClaim": {"claimName": claim["metadata"]["name"]}}
            ]
        },
        status={
            "containerStatuses": [
                {
                    "name": "mysql",
                    "imageID": "docker-pullable://mysql@sha256:" + "a" * 64,
                }
            ]
        },
    )
    app = resource(
        "Application",
        "core-service",
        "argocd",
        spec={
            "project": "govbiz-fork",
            "destination": {
                "namespace": "govbiz-msa",
                "server": "https://source.invalid",
            },
            "source": {
                "targetRevision": "b" * 40,
                "helm": {
                    "kubeVersion": "1.36.4",
                    "valuesObject": {
                        "serviceName": "core-service",
                        "env": {"ACCOUNT_DEV_LOGIN_ENABLED": "true"},
                    },
                },
            },
        },
    )
    return {
        "claims": [["govbiz-msa", "data-core-mysql-0"]],
        "resources": [claim, store, pod],
        "applications": [app],
        "projects": [],
    }


def manifest_configuration():
    config = configuration()
    config.update(sourceMode="manifests", applications=[])
    pod = config["resources"][1]["spec"]["template"]["spec"]
    pod["containers"][0]["image"] = (
        "docker.io/govbiz-migration/mysql@sha256:" + "a" * 64
    )
    pod["initContainers"] = [
        {
            "name": "restored",
            "image": "docker.io/govbiz-migration/helper@sha256:" + "b" * 64,
        }
    ]
    claim = resource(
        "PersistentVolumeClaim",
        "results",
        "govbiz-evaluation",
        spec={"resources": {"requests": {"storage": "20Gi"}}},
    )
    config["resources"].append(claim)
    config["claims"].append(["govbiz-evaluation", "results"])
    for ns, name in (
        ("govbiz-msa", "ai-service"),
        ("govbiz-msa", "web"),
        ("govbiz-evaluation", "evaluation-runner"),
        ("govbiz-evaluation", "ops-artifacts"),
        ("govbiz-observability", "langfuse-web"),
    ):
        p = {
            "nodeSelector": {"kubernetes.io/hostname": "source"},
            "containers": [
                {
                    "name": name,
                    "image": "docker.io/govbiz-migration/app@sha256:" + "c" * 64,
                    "env": [{"name": "LLMOPS_LIVE_ENABLED", "value": "true"}],
                }
            ],
        }
        if ns == "govbiz-evaluation":
            p["volumes"] = [
                {"name": "data", "persistentVolumeClaim": {"claimName": "results"}}
            ]
        config["resources"].append(
            resource(
                "Deployment", name, ns, spec={"replicas": 1, "template": {"spec": p}}
            )
        )
    config["resources"].append(
        resource(
            "Service",
            "web",
            spec={
                "type": "ClusterIP",
                "clusterIP": "10.0.0.1",
                "ports": [{"port": 8080}],
            },
        )
    )
    config["resources"].append(
        resource(
            "NetworkPolicy",
            "isolation",
            spec={"podSelector": {}, "policyTypes": ["Ingress"]},
        )
    )
    return config


def published_images(config):
    return {
        i["source"]: "registry.example/" + i["source"].split("govbiz-migration/")[1]
        for i in handoff.manifest_inventory(config)["images"]
    }


class HandoffTests(unittest.TestCase):
    def test_sydney_demo_has_one_node_per_stable_pool_in_same_data_zone(self):
        path = Path(__file__).resolve().parents[2] / "eks/cluster.sydney-demo.yaml"
        cluster = yaml.safe_load(path.read_text())
        self.assertEqual(cluster["metadata"]["region"], "ap-southeast-2")
        self.assertEqual(len(cluster["availabilityZones"]), 2)
        groups = cluster["managedNodeGroups"]
        self.assertEqual(
            {g["labels"][handoff.POOL_LABEL] for g in groups},
            {"application", "observability"},
        )
        for g in groups:
            self.assertEqual(g["instanceType"], "m7i-flex.large")
            self.assertEqual(
                (g["minSize"], g["desiredCapacity"], g["maxSize"]), (1, 1, 1)
            )
            self.assertEqual(g["availabilityZones"], ["ap-southeast-2a"])
            self.assertTrue(g["privateNetworking"])
            self.assertTrue(g["volumeEncrypted"])
            self.assertTrue(g["disableIMDSv1"])
        self.assertEqual(cluster["vpc"]["nat"]["gateway"], "Single")
        self.assertEqual(cluster["vpc"]["publicAccessCIDRs"], ["203.0.113.1/32"])

    @unittest.skipUnless(
        os.name == "posix", "Filesystem ownership/link restore runs in Linux CI"
    )
    def test_compressed_tar_restores_contents_permissions_and_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, target = root / "source", root / "target"
            source.mkdir()
            target.mkdir()
            original = source / "한글.txt"
            original.write_text("보존할 데이터", encoding="utf-8")
            original.chmod(0o640)
            os.link(original, source / "hardlink")
            (source / "symlink").symlink_to("한글.txt")
            key = b"4" * 64 + b"\n"
            archive = root / "archive"
            manifest = handoff.archive_stream(
                [
                    "tar",
                    "--numeric-owner",
                    "--sparse",
                    "-czpf",
                    "-",
                    "-C",
                    str(source),
                    ".",
                ],
                archive,
                key,
            )
            handoff.restore_stream(
                [
                    "tar",
                    "--numeric-owner",
                    "--same-owner",
                    "--same-permissions",
                    "-xzpf",
                    "-",
                    "-C",
                    str(target),
                ],
                archive,
                manifest,
                key,
            )
            restored = target / "한글.txt"
            self.assertEqual(restored.read_bytes(), original.read_bytes())
            self.assertEqual(restored.stat().st_mode, original.stat().st_mode)
            self.assertEqual(restored.stat().st_uid, original.stat().st_uid)
            self.assertEqual(restored.stat().st_gid, original.stat().st_gid)
            self.assertEqual(
                restored.stat().st_ino, (target / "hardlink").stat().st_ino
            )
            self.assertEqual(os.readlink(target / "symlink"), "한글.txt")

    def test_destination_preserves_db_identity_but_removes_source_storage_and_credentials(
        self,
    ):
        config = configuration()
        original = copy.deepcopy(config)
        out = handoff.destination(
            config, "ip-10-0-0-1", "registry.example/elasticsearch@sha256:" + "c" * 64
        )
        self.assertEqual(config, original)
        claim = out["10-claims.json"]["items"][0]
        self.assertEqual(
            claim["metadata"], {"name": "data-core-mysql-0", "namespace": "govbiz-msa"}
        )
        self.assertNotIn("volumeName", claim["spec"])
        self.assertEqual(claim["spec"]["storageClassName"], "govbiz-ebs-gp3")
        self.assertEqual(claim["spec"]["resources"]["requests"]["storage"], "10Gi")
        store = out["30-data-stopped.json"]["items"][0]["spec"]
        self.assertEqual(store["replicas"], 0)
        self.assertNotIn("volumeClaimTemplates", store)
        pod = store["template"]["spec"]
        self.assertNotIn("nodeName", pod)
        self.assertEqual(
            pod["volumes"][0]["persistentVolumeClaim"]["claimName"], "data-core-mysql-0"
        )
        self.assertIn("@sha256:", pod["containers"][0]["image"])
        app = out["50-applications.json"]["items"][0]
        self.assertEqual(app["spec"]["source"]["targetRevision"], "b" * 40)
        self.assertFalse(app["spec"]["syncPolicy"]["automated"]["enabled"])
        self.assertNotIn("kubeVersion", app["spec"]["source"]["helm"])
        self.assertEqual(
            app["spec"]["source"]["helm"]["valuesObject"]["env"][
                "ACCOUNT_DEV_LOGIN_ENABLED"
            ],
            "false",
        )
        self.assertNotIn("PRIVATE", json.dumps(out))

    def test_skip_unreferenced_old_claims_keep_receipts(self):
        config = configuration()
        config["resources"].append(resource("PersistentVolumeClaim", "old-stage2"))
        config["resources"].append(
            resource("PersistentVolumeClaim", "catalog-sync-receipts")
        )
        self.assertEqual(
            handoff.referenced_claims(config["resources"]),
            [
                ("govbiz-msa", "catalog-sync-receipts"),
                ("govbiz-msa", "data-core-mysql-0"),
            ],
        )

    def test_absent_optional_receipts_are_not_invented(self):
        self.assertEqual(
            handoff.referenced_claims(configuration()["resources"]),
            [("govbiz-msa", "data-core-mysql-0")],
        )

    def test_manifest_capture_without_argo_crds_still_requires_referenced_pvcs(self):
        def answer(kube, *args):
            if args[:2] == ("get", "namespace"):
                return {"metadata": {"uid": "original"}}
            if args[-1] == "cronjobs":
                return {"items": []}
            if args[1] == "govbiz-msa":
                return {"items": configuration()["resources"]}
            return {"items": []}

        with (
            patch.object(handoff, "get", side_effect=answer),
            patch.object(handoff.snapshot, "run", return_value=b""),
        ):
            config = handoff.collect([], "manifests")
        self.assertEqual(config["sourceMode"], "manifests")
        self.assertEqual(config["applications"], [])
        self.assertEqual(config["claims"], [("govbiz-msa", "data-core-mysql-0")])
        broken = configuration()["resources"][1:]

        def missing(kube, *args):
            result = answer(kube, *args)
            if (
                args[-1] == "deploy,sts,pvc,pods,svc,cm,secret,networkpolicy"
                and args[1] == "govbiz-msa"
            ):
                return {"items": broken}
            return result

        with (
            patch.object(handoff, "get", side_effect=missing),
            patch.object(handoff.snapshot, "run", return_value=b""),
            self.assertRaisesRegex(handoff.snapshot.SnapshotError, "PVC is missing"),
        ):
            handoff.collect([], "manifests")

    def test_manifest_mode_cannot_bypass_argo_ownership(self):
        def answer(kube, *args):
            if args[:2] == ("get", "namespace"):
                return {"metadata": {"uid": "original"}}
            if "applications" in args:
                return {
                    "items": [{"spec": {"destination": {"namespace": "govbiz-msa"}}}]
                }
            return {"items": []}

        with (
            patch.object(handoff, "get", side_effect=answer),
            patch.object(
                handoff.snapshot, "run", return_value=b"applications.argoproj.io\n"
            ),
            self.assertRaisesRegex(handoff.snapshot.SnapshotError, "Argo-managed"),
        ):
            handoff.collect([], "manifests")

    def test_two_pool_manifest_preserves_storage_policies_and_all_images(self):
        config = manifest_configuration()
        original = copy.deepcopy(config)
        image_map = published_images(config)
        out = handoff.manifest_destination(config, image_map)
        self.assertEqual(config, original)
        stores = out["30-data-stopped.json"]["items"]
        self.assertEqual(stores[0]["spec"]["replicas"], 0)
        self.assertEqual(
            stores[0]["spec"]["persistentVolumeClaimRetentionPolicy"]["whenDeleted"],
            "Retain",
        )
        self.assertNotIn("volumeClaimTemplates", stores[0]["spec"])
        apps = {
            a["metadata"]["name"]: a for a in out["50-workloads-stopped.json"]["items"]
        }
        for name in ("evaluation-runner", "ops-artifacts"):
            spec = apps[name]["spec"]
            self.assertEqual(
                spec["template"]["spec"]["nodeSelector"],
                {handoff.POOL_LABEL: "application"},
            )
            self.assertEqual(spec["strategy"], {"type": "Recreate"})
            terms = spec["template"]["spec"]["affinity"]["podAffinity"][
                "requiredDuringSchedulingIgnoredDuringExecution"
            ]
            self.assertEqual(terms[0]["topologyKey"], "kubernetes.io/hostname")
            self.assertEqual(
                terms[0]["labelSelector"]["matchLabels"],
                {"govbiz.io/evaluation-volume": "shared"},
            )
        for name in ("web", "ai-service", "langfuse-web"):
            self.assertEqual(
                apps[name]["spec"]["template"]["spec"]["nodeSelector"],
                {handoff.POOL_LABEL: "observability"},
            )
        for w in stores + list(apps.values()):
            self.assertEqual(w["spec"]["replicas"], 0)
            pod = w["spec"]["template"]["spec"]
            self.assertNotIn("nodeName", pod)
            self.assertNotIn("kubernetes.io/hostname", pod["nodeSelector"])
            for c in pod["containers"] + pod.get("initContainers", []):
                self.assertIn(c["image"], image_map.values())
                self.assertEqual(c["imagePullPolicy"], "IfNotPresent")
        self.assertIn(
            "NetworkPolicy",
            [r["kind"] for r in out["25-services-and-policies.json"]["items"]],
        )
        for s in out["25-services-and-policies.json"]["items"]:
            if s["kind"] == "Service":
                self.assertNotIn("clusterIP", s["spec"])
        for claim in out["10-claims.json"]["items"]:
            self.assertNotIn("volumeName", claim["spec"])
        self.assertEqual(out["startup-plan.json"]["automaticStart"], False)
        self.assertEqual(len(out["startup-plan.json"]["workloads"]), 6)
        env = apps["evaluation-runner"]["spec"]["template"]["spec"]["containers"][0][
            "env"
        ]
        self.assertEqual(
            next(e["value"] for e in env if e["name"] == "LLMOPS_LIVE_ENABLED"), "false"
        )

    def test_manifest_export_accepts_published_migration_repository_but_not_local_alias(
        self,
    ):
        config = manifest_configuration()
        sources = [i["source"] for i in handoff.manifest_inventory(config)["images"]]
        image_map = {
            source: "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/"
            + source.removeprefix("docker.io/")
            for source in sources
        }
        out = handoff.manifest_destination(config, image_map)
        for filename in ("30-data-stopped.json", "50-workloads-stopped.json"):
            for workload in out[filename]["items"]:
                pod = workload["spec"]["template"]["spec"]
                for container in pod["containers"] + pod.get("initContainers", []):
                    self.assertIn(container["image"], image_map.values())
        for prefix in ("", "docker.io/", "index.docker.io/", "registry-1.docker.io/"):
            with (
                self.subTest(prefix=prefix),
                self.assertRaisesRegex(
                    handoff.snapshot.SnapshotError, "pullable registry"
                ),
            ):
                handoff.manifest_destination(
                    config,
                    {
                        source: prefix + source.removeprefix("docker.io/")
                        for source in sources
                    },
                )

    @unittest.skipIf(os.name == "nt", "Linux container cookie permissions")
    def test_manifest_export_repairs_restored_rabbit_cookie_without_root_or_new_image(
        self,
    ):
        config = manifest_configuration()
        store = config["resources"][1]
        store["metadata"]["name"] = "rabbitmq"
        store["spec"].pop("volumeClaimTemplates")
        pod = store["spec"]["template"]["spec"]
        pod["securityContext"] = {"runAsUser": 999, "runAsGroup": 999, "fsGroup": 999}
        pod["volumes"] = [
            {
                "name": "data",
                "persistentVolumeClaim": {"claimName": "data-core-mysql-0"},
            }
        ]
        pod["containers"][0].update(
            name="rabbitmq",
            volumeMounts=[{"name": "data", "mountPath": "/var/lib/rabbitmq"}],
        )
        original = copy.deepcopy(config)
        out = handoff.manifest_destination(config, published_images(config))
        self.assertEqual(config, original)
        target = out["30-data-stopped.json"]["items"][0]["spec"]["template"]["spec"]
        self.assertEqual(target["securityContext"], pod["securityContext"])
        self.assertEqual(target["initContainers"][0]["name"], "restored")
        repair = target["initContainers"][-1]
        self.assertEqual(repair["image"], target["containers"][0]["image"])
        self.assertEqual(repair["volumeMounts"], pod["containers"][0]["volumeMounts"])
        self.assertEqual(repair["securityContext"]["runAsNonRoot"], True)
        self.assertEqual(repair["securityContext"]["capabilities"], {"drop": ["ALL"]})
        self.assertNotIn("env", repair)
        with tempfile.TemporaryDirectory() as temp:
            cookie = Path(temp) / ".erlang.cookie"
            cookie.write_text("existing-cookie")
            cookie.chmod(0o660)  # EBS fsGroup adds group access during mounting.
            command = [
                part.replace("/var/lib/rabbitmq", temp) for part in repair["command"]
            ]
            subprocess.run(command, check=True, capture_output=True)
            self.assertEqual(cookie.stat().st_mode & 0o777, 0o600)
            self.assertEqual(cookie.read_text(), "existing-cookie")
            cookie.unlink()
            subprocess.run(command, check=True, capture_output=True)
            self.assertFalse(cookie.exists())

    def test_manifest_export_rejects_missing_init_image_and_unsafe_placement(self):
        config = manifest_configuration()
        image_map = published_images(config)
        init = config["resources"][1]["spec"]["template"]["spec"]["initContainers"][0][
            "image"
        ]
        del image_map[init]
        with self.assertRaisesRegex(
            handoff.snapshot.SnapshotError, "every captured image"
        ):
            handoff.manifest_destination(config, image_map)
        for mutate, message in (
            (lambda p: p.update(serviceAccountName="custom"), "service account"),
            (lambda p: p.update(affinity={"nodeAffinity": {}}), "scheduling"),
            (lambda p: p["containers"][0].update(image="app:latest"), "Pin all"),
        ):
            copy_config = copy.deepcopy(config)
            mutate(copy_config["resources"][1]["spec"]["template"]["spec"])
            with (
                self.subTest(message=message),
                self.assertRaisesRegex(handoff.snapshot.SnapshotError, message),
            ):
                handoff.manifest_inventory(copy_config)
        ai = next(
            r for r in config["resources"] if r["metadata"]["name"] == "ai-service"
        )
        ai["spec"]["template"]["spec"]["volumes"] = [
            {
                "name": "data",
                "persistentVolumeClaim": {"claimName": "data-core-mysql-0"},
            }
        ]
        with self.assertRaisesRegex(
            handoff.snapshot.SnapshotError, "namespace restore pool"
        ):
            handoff.manifest_inventory(config)

    def test_vercel_export_omits_web_but_preserves_data_and_backend_auth_settings(self):
        config = manifest_configuration()
        origin = "https://govbiz-demo.vercel.app"
        for name in ("core-service", "ops-service"):
            row = copy.deepcopy(
                next(
                    r
                    for r in config["resources"]
                    if r["metadata"]["name"] == "ai-service"
                )
            )
            row["metadata"]["name"] = name
            container = row["spec"]["template"]["spec"]["containers"][0]
            container["env"] += [
                {"name": key, "value": "http://localhost:5173"}
                for key in (
                    "APP_CORS_ALLOWED_ORIGIN",
                    "ACCOUNT_OAUTH_CALLBACK_BASE_URL",
                    "ACCOUNT_OAUTH_FRONTEND_BASE_URL",
                    "DAILY_REPORT_FRONTEND_BASE_URL",
                    "OPS_WEB_URL",
                    "DJANGO_CSRF_TRUSTED_ORIGINS",
                )
            ]
            config["resources"].append(row)
        original = copy.deepcopy(config)
        image_map = published_images(config)
        baseline = handoff.manifest_destination(config, image_map)
        out = handoff.manifest_destination(config, image_map, origin)
        self.assertEqual(config, original)
        for filename in (
            "10-claims.json",
            "20-private-dependencies.json",
            "30-data-stopped.json",
        ):
            self.assertEqual(out[filename], baseline[filename])
        apps = {
            a["metadata"]["name"]: a for a in out["50-workloads-stopped.json"]["items"]
        }
        self.assertNotIn("web", apps)
        self.assertIn("langfuse-web", apps)
        self.assertFalse(
            any(
                r["kind"] == "Service" and r["metadata"]["name"] == "web"
                for r in out["25-services-and-policies.json"]["items"]
            )
        )
        self.assertIn(
            "NetworkPolicy",
            [r["kind"] for r in out["25-services-and-policies.json"]["items"]],
        )
        self.assertFalse(
            any(w["name"] == "web" for w in out["startup-plan.json"]["workloads"])
        )
        self.assertEqual(
            out["startup-plan.json"]["frontend"],
            {"hosting": "vercel", "origin": origin},
        )
        for name, required in (
            (
                "core-service",
                {
                    "APP_CORS_ALLOWED_ORIGIN": origin,
                    "ACCOUNT_OAUTH_CALLBACK_BASE_URL": origin,
                    "ACCOUNT_OAUTH_FRONTEND_BASE_URL": origin,
                    "DAILY_REPORT_FRONTEND_BASE_URL": origin,
                    "ACCOUNT_COOKIE_SECURE": "true",
                    "ACCOUNT_DEV_LOGIN_ENABLED": "false",
                },
            ),
            (
                "ops-service",
                {
                    "OPS_WEB_URL": origin,
                    "DJANGO_CSRF_TRUSTED_ORIGINS": origin,
                    "DJANGO_COOKIE_SECURE": "true",
                    "LLMOPS_LIVE_ENABLED": "false",
                    "LLMOPS_RAG_LIVE_ENABLED": "false",
                    "LLMOPS_SCHEDULES_ENABLED": "false",
                },
            ),
        ):
            env = apps[name]["spec"]["template"]["spec"]["containers"][0]["env"]
            for key, value in required.items():
                self.assertEqual(
                    [e.get("value") for e in env if e["name"] == key], [value]
                )

    def test_vercel_export_accepts_only_the_canonical_https_origin(self):
        config = manifest_configuration()
        for origin in (
            "",
            "http://govbiz.vercel.app",
            "https://govbiz.vercel.app/",
            "https://govbiz.vercel.app/api",
            "https://govbiz.vercel.app.evil.com",
            "https://user@govbiz.vercel.app",
            "https://govbiz.vercel.app?x=1",
            "https://govbiz.vercel.app:443",
            "http://localhost:5173",
        ):
            with (
                self.subTest(origin=origin),
                self.assertRaisesRegex(
                    handoff.snapshot.SnapshotError, "canonical HTTPS"
                ),
            ):
                handoff.manifest_destination(config, published_images(config), origin)

    def test_vercel_image_map_may_omit_only_images_exclusive_to_web(self):
        config = manifest_configuration()
        web = next(
            r
            for r in config["resources"]
            if r["kind"] == "Deployment" and r["metadata"]["name"] == "web"
        )
        image = "docker.io/govbiz-migration/web@sha256:" + "d" * 64
        web["spec"]["template"]["spec"]["containers"][0]["image"] = image
        image_map = published_images(config)
        origin = "https://govbiz-demo.vercel.app"
        full = handoff.manifest_destination(config, image_map, origin)
        del image_map[image]
        self.assertEqual(full, handoff.manifest_destination(config, image_map, origin))
        with self.assertRaisesRegex(
            handoff.snapshot.SnapshotError, "every captured image"
        ):
            handoff.manifest_destination(config, image_map)
        # Shared backend/init images remain required even when the web uses them.
        init_image = config["resources"][1]["spec"]["template"]["spec"][
            "initContainers"
        ][0]["image"]
        web["spec"]["template"]["spec"]["initContainers"] = [
            {"name": "shared", "image": init_image}
        ]
        del image_map[init_image]
        with self.assertRaisesRegex(
            handoff.snapshot.SnapshotError, "every captured image"
        ):
            handoff.manifest_destination(config, image_map, origin)

    def test_pool_restore_helper_uses_same_pool_as_volume_consumers(self):
        for ns in handoff.NAMESPACES:
            pool = handoff.workload_pool(ns, "")
            p = handoff.helper(
                ns, ["restored"], None, "copy", readonly=False, pool=pool
            )
            self.assertEqual(p["spec"]["nodeSelector"], {handoff.POOL_LABEL: pool})
            self.assertFalse(
                p["spec"]["volumes"][0]["persistentVolumeClaim"]["readOnly"]
            )

    def test_backup_helper_cannot_write_source_and_has_no_api_token(self):
        pod = handoff.helper(
            "govbiz-msa", ["data-core-mysql-0"], "source", "copy", readonly=True
        )["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(pod["volumes"][0]["persistentVolumeClaim"]["readOnly"])
        self.assertTrue(pod["containers"][0]["volumeMounts"][0]["readOnly"])

    def test_same_cluster_restore_and_live_backup_are_rejected(self):
        config = {"namespaces": {n: "original" for n in handoff.NAMESPACES}}
        with (
            patch.object(
                handoff, "get", return_value={"metadata": {"uid": "original"}}
            ),
            self.assertRaisesRegex(handoff.snapshot.SnapshotError, "original cluster"),
        ):
            handoff.stopped([], config, source=False)
        with (
            patch.object(
                handoff,
                "get",
                side_effect=[
                    {"metadata": {"uid": "original"}},
                    {"items": [{"spec": {"replicas": 1}}]},
                ],
            ),
            self.assertRaisesRegex(handoff.snapshot.SnapshotError, "Stop application"),
        ):
            handoff.stopped([], config, source=True)

    def test_encrypted_multichunk_round_trip_and_corruption_before_write(self):
        key = b"4" * 64 + b"\n"
        payload = "한글 계정/공고/평가\n".encode() * 100
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            source.write_bytes(payload)
            archive = root / "archive"
            reader = [
                sys.executable,
                "-c",
                "import pathlib,sys; sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())",
                str(source),
            ]
            with patch.object(handoff, "CHUNK_SIZE", 1024):
                manifest = handoff.archive_stream(reader, archive, key)
            self.assertGreater(len(manifest["chunks"]), 1)
            self.assertEqual(manifest["sha256"], hashlib.sha256(payload).hexdigest())
            target = root / "target"
            writer = [
                sys.executable,
                "-c",
                "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",
                str(target),
            ]
            handoff.restore_stream(writer, archive, manifest, key)
            self.assertEqual(target.read_bytes(), payload)
            target.unlink()
            chunk = archive / manifest["chunks"][-1]["file"]
            chunk.write_bytes(chunk.read_bytes() + b"tampered")
            with self.assertRaisesRegex(handoff.snapshot.SnapshotError, "Damaged"):
                handoff.restore_stream(writer, archive, manifest, key)
            self.assertFalse(target.exists())

    def test_failed_tar_never_returns_a_complete_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            command = [
                sys.executable,
                "-c",
                "import sys; sys.stdout.buffer.write(b'partial'); sys.stderr.write('context deadline exceeded'); sys.exit(1)",
            ]
            with self.assertRaisesRegex(
                handoff.snapshot.SnapshotError, "deadline exceeded"
            ):
                handoff.archive_stream(
                    command, Path(temp) / "archive", b"4" * 64 + b"\n"
                )


if __name__ == "__main__":
    unittest.main()
