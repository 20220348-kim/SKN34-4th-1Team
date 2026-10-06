"""Deployment scheduling declarations must survive compatibility review."""

import copy
import json
import unittest

import gitops_runtime as runtime


class SchedulingTests(unittest.TestCase):
    def review(self, actual, expected=None):
        def deployment(pod):
            return {"spec": {"template": {"spec": {"containers": [], **pod}}}}

        return runtime.policy_review(deployment(actual), deployment(expected or {}))

    def test_placement_changes_report_fixed_field_names_only(self):
        settings = {
            "nodeSelector": {"PRIVATE-label": "PRIVATE-node"},
            "nodeName": "PRIVATE-node",
            "affinity": {"nodeAffinity": {"PRIVATE-extension": "PRIVATE"}},
            "tolerations": [{"key": "PRIVATE-taint", "operator": "Exists"}],
            "topologySpreadConstraints": [
                {"topologyKey": "PRIVATE-zone", "maxSkew": 1}
            ],
            "schedulerName": "PRIVATE-scheduler",
            "schedulingGates": [{"name": "PRIVATE-gate"}],
            "priorityClassName": "PRIVATE-priority",
            "priority": 100,
            "preemptionPolicy": "Never",
            "runtimeClassName": "PRIVATE-runtime",
            "resourceClaims": [
                {"name": "PRIVATE-claim", "resourceClaimName": "PRIVATE"}
            ],
        }
        for field, value in settings.items():
            with self.subTest(field=field):
                for left, right in (({field: value}, {}), ({}, {field: value})):
                    report = self.review(left, right)
                    self.assertEqual(report["changedFields"], [field])
                    self.assertNotIn("PRIVATE", json.dumps(report))

    def test_default_scheduler_and_empty_collections_are_equivalent(self):
        for name in ("", "default-scheduler"):
            self.assertEqual(
                self.review(
                    {
                        "schedulerName": name,
                        "nodeSelector": {},
                        "nodeName": "",
                        "affinity": {},
                        "tolerations": [],
                        "topologySpreadConstraints": [],
                        "schedulingGates": [],
                        "resourceClaims": [],
                        "priorityClassName": "",
                    }
                )["changedFields"],
                [],
            )

    def test_toleration_defaults_and_order_do_not_modify_inputs(self):
        observed = {
            "tolerations": [
                {
                    "key": "dedicated",
                    "operator": "Equal",
                    "value": "ops",
                    "effect": "",
                    "tolerationSeconds": None,
                },
                {
                    "key": "temporary",
                    "operator": "Exists",
                    "value": "",
                    "effect": "NoExecute",
                    "tolerationSeconds": 0,
                },
            ]
        }
        expected = {
            "tolerations": [
                {
                    "key": "temporary",
                    "operator": "Exists",
                    "effect": "NoExecute",
                    "tolerationSeconds": 0,
                },
                {"key": "dedicated", "value": "ops"},
            ]
        }
        before = copy.deepcopy((observed, expected))
        self.assertEqual(self.review(observed, expected)["changedFields"], [])
        self.assertEqual((observed, expected), before)
        del observed["tolerations"][1]["tolerationSeconds"]
        self.assertEqual(
            self.review(observed, expected)["changedFields"], ["tolerations"]
        )

    def test_list_order_is_ignored_but_duplicates_and_extensions_are_preserved(self):
        for field in (
            "tolerations",
            "topologySpreadConstraints",
            "schedulingGates",
            "resourceClaims",
        ):
            with self.subTest(field=field):
                entries = [{"name": "PRIVATE-a"}, {"name": "PRIVATE-b"}]
                left, right = {field: entries}, {field: list(reversed(entries))}
                self.assertEqual(self.review(left, right)["changedFields"], [])
                right[field] = entries + [entries[0]]
                self.assertEqual(self.review(left, right)["changedFields"], [field])
                right[field] = [entries[0] | {"PRIVATE-extension": True}, entries[1]]
                self.assertEqual(self.review(left, right)["changedFields"], [field])

    def test_admission_values_are_not_assumed_from_missing_declarations(self):
        for field, value in (
            ("priority", 0),
            ("preemptionPolicy", "PreemptLowerPriority"),
            ("runtimeClassName", "PRIVATE-runtime"),
        ):
            with self.subTest(field=field):
                self.assertEqual(self.review({field: value})["changedFields"], [field])

    def test_nested_affinity_conditions_are_not_dropped(self):
        expected = {
            "affinity": {
                "nodeAffinity": {
                    "requiredDuringSchedulingIgnoredDuringExecution": {
                        "nodeSelectorTerms": [
                            {
                                "matchExpressions": [
                                    {
                                        "key": "PRIVATE-label",
                                        "operator": "In",
                                        "values": ["PRIVATE-a"],
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        }
        actual = copy.deepcopy(expected)
        terms = actual["affinity"]["nodeAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"
        ]["nodeSelectorTerms"]
        terms[0]["matchExpressions"][0]["values"] = ["PRIVATE-b"]
        self.assertEqual(self.review(actual, expected)["changedFields"], ["affinity"])

    def test_malformed_lists_fail_without_echoing_values(self):
        for field in (
            "tolerations",
            "topologySpreadConstraints",
            "schedulingGates",
            "resourceClaims",
        ):
            for value in (None, "PRIVATE", {"PRIVATE": True}, ["PRIVATE"]):
                with (
                    self.subTest(field=field, value=value),
                    self.assertRaisesRegex(
                        ValueError, "^Invalid scheduling declaration$"
                    ),
                ):
                    self.review({field: value})


if __name__ == "__main__":
    unittest.main()
