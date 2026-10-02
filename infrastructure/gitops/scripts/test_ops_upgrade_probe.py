"""Outstanding or incomplete evidence must never permit an Ops upgrade."""

import copy
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

import ops_upgrade_probe as probe

NAME = "govbiz-ops-evidence-evaluation/saved-capture"


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.database = {
            "states": {"COMPLETED": 2},
            "open_reservations": 0,
            "admission": {"accepting": False, "version": 1},
        }
        self.deployment = {
            "id": str(uuid4()),
            "flow_id": str(uuid4()),
            "name": "saved-capture",
            "paused": False,
            "schedules": [],
        }
        self.rows = []
        self.calls = []
        self.counts = []
        self.patch = patch.object(
            probe, "database_snapshot", side_effect=lambda: self.database
        )
        self.read_database = self.patch.start()
        self.addCleanup(self.patch.stop)

    def request(self, path, payload=None, *, expected_type=dict):
        self.calls.append((path, payload))
        if path == "/deployments/name/" + NAME:
            self.assertIsNone(payload)
            return copy.deepcopy(self.deployment)
        selection = {"flows": {"id": {"any_": [self.deployment["flow_id"]]}}}
        if path == "/flow_runs/count":
            self.assertEqual(payload, selection)
            self.assertIs(expected_type, int)
            return self.counts.pop(0) if self.counts else len(self.rows)
        if path == "/flow_runs/filter":
            self.assertIs(expected_type, list)
            self.assertEqual(payload["flows"], selection["flows"])
            self.assertEqual(payload["sort"], "ID_DESC")
            self.assertEqual(payload["limit"], probe.PAGE_SIZE)
            return self.rows[payload["offset"] : payload["offset"] + payload["limit"]]
        raise AssertionError("Non-read operation: " + path)

    def row(self, state="COMPLETED"):
        return {
            "id": str(uuid4()),
            "flow_id": self.deployment["flow_id"],
            "state_type": state,
        }

    def inspect(self):
        return probe.inspect_upgrade(self.request, NAME)

    def test_paused_terminal_history_passes_without_claiming_backup_or_writes(self):
        self.rows = [self.row(state) for state in probe.TERMINAL]
        before = copy.deepcopy((self.rows, self.database, self.deployment))
        result = self.inspect()
        self.assertEqual(result["schemaVersion"], 3)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["checks"]["inspected_flows"], 4)
        self.assertTrue(result["admission_supported"])
        self.assertTrue(result["admission_blocked"])
        self.assertEqual(result["admission_version"], 1)
        self.assertFalse(result["backup_verified"])
        self.assertFalse(result["evaluation_executed"])
        self.assertEqual(before, (self.rows, self.database, self.deployment))
        self.assertNotIn(self.deployment["id"], json.dumps(result))

    def test_legacy_image_cannot_pass_even_without_outstanding_work(self):
        for admission in ({}, {"admission": None}):
            self.database = {
                "states": {"COMPLETED": 2},
                "open_reservations": 0,
                **admission,
            }
            with self.subTest(admission=admission):
                report = self.inspect()
                self.assertEqual(report["status"], "BLOCKED")
                self.assertEqual(report["reason"], "admission_control_unsupported")
                self.assertFalse(report["admission_supported"])
                self.assertFalse(report["admission_blocked"])
                self.assertNotIn("admission_version", report)
                self.assertIsNone(report["checks"]["open_admission"])
                self.assertTrue(
                    all(
                        value == 0
                        for key, value in report["checks"].items()
                        if key != "open_admission"
                    )
                )

    def test_every_unsettled_ops_state_and_unknown_status_blocks(self):
        for state in (
            "REQUESTED",
            "QUEUED",
            "RUNNING",
            "CANCELLING",
            "RESULT_ERROR",
            "NEW",
        ):
            self.database["states"] = {state: 1}
            with self.subTest(state=state):
                self.assertEqual(self.inspect()["status"], "BLOCKED")

    def test_open_reservation_blocks_even_after_terminal_evaluation(self):
        self.database["open_reservations"] = 1
        self.assertEqual(self.inspect()["status"], "BLOCKED")

    def test_supported_admission_must_be_paused_and_version_is_recorded(self):
        self.database["admission"] = {"accepting": True, "version": 0}
        report = self.inspect()
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["reason"], "admission_open")
        self.assertEqual(report["checks"]["open_admission"], 1)
        self.assertTrue(report["admission_supported"])
        self.assertFalse(report["admission_blocked"])
        self.database["admission"] = {"accepting": False, "version": 7}
        report = self.inspect()
        self.assertEqual(report["status"], "PASS")
        self.assertTrue(report["admission_supported"])
        self.assertTrue(report["admission_blocked"])
        self.assertEqual(report["admission_version"], 7)

    def test_admission_change_or_incomplete_state_is_unknown(self):
        for admission in (
            {},
            {"accepting": "false", "version": 0},
            {"accepting": False, "version": -1},
            {"accepting": False, "version": 0},
            {"accepting": False, "version": True},
            {"accepting": False, "version": "1"},
            {"accepting": False},
        ):
            self.database["admission"] = admission
            with self.subTest(admission=admission):
                self.assertEqual(self.inspect()["status"], "UNKNOWN")
        self.read_database.side_effect = [
            {**self.database, "admission": {"accepting": False, "version": 1}},
            {**self.database, "admission": {"accepting": False, "version": 3}},
        ]
        self.assertEqual(self.inspect()["status"], "UNKNOWN")

    def test_every_nonterminal_prefect_state_blocks(self):
        for state in probe.PREFECT_ACTIVE:
            self.rows = [self.row(state)]
            with self.subTest(state=state):
                self.assertEqual(self.inspect()["status"], "BLOCKED")

    def test_active_schedule_blocks_even_when_deployment_is_paused(self):
        self.deployment["schedules"] = [{"id": str(uuid4()), "active": True}]
        for paused in (True, False):
            self.deployment["paused"] = paused
            self.assertEqual(self.inspect()["status"], "BLOCKED")
        self.deployment["schedules"][0]["active"] = False
        self.assertEqual(self.inspect()["status"], "PASS")

    def test_checks_later_pages_and_old_deployments_of_same_flow(self):
        self.rows = [self.row() for _ in range(probe.PAGE_SIZE + 1)]
        self.rows[-1].update(state_type="RUNNING", deployment_id=str(uuid4()))
        result = self.inspect()
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["checks"]["unfinished_flows"], 1)
        self.assertEqual(result["checks"]["inspected_flows"], len(self.rows))

    def test_invalid_null_foreign_or_duplicate_flows_are_unknown(self):
        for rows in (
            [self.row(None)],
            [self.row("NEW_STATE")],
            [{**self.row(), "flow_id": str(uuid4())}],
            [{**self.row(), "id": "bad"}],
            [self.row()] * 2,
        ):
            self.rows = rows
            with self.subTest(rows=rows):
                self.assertEqual(self.inspect()["status"], "UNKNOWN")

    def test_incomplete_oversized_or_changing_history_is_unknown(self):
        for counts in ([1], [-1], [True], [0, 1], [probe.PAGE_SIZE * probe.MAX_PAGES]):
            self.counts = counts.copy()
            with self.subTest(counts=counts):
                self.assertEqual(self.inspect()["status"], "UNKNOWN")

    def test_missing_or_malformed_schedule_evidence_is_unknown(self):
        original = copy.deepcopy(self.deployment)
        for change in (
            {"schedules": None},
            {"schedules": [{}]},
            {"paused": 0},
            {"schedules": [{"id": str(uuid4()), "active": "false"}]},
            {"name": "other"},
            {"flow_id": "bad"},
        ):
            self.deployment = original | change
            self.assertEqual(self.inspect()["status"], "UNKNOWN")
        self.deployment = original
        del self.deployment["schedules"]
        self.assertEqual(self.inspect()["status"], "UNKNOWN")

    def test_database_or_schedule_changes_during_inspection_are_unknown(self):
        self.read_database.side_effect = [
            self.database,
            {**self.database, "open_reservations": 1},
        ]
        self.assertEqual(self.inspect()["status"], "UNKNOWN")
        self.read_database.side_effect = lambda: self.database
        original = self.request

        def changing(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == "/flow_runs/filter":
                self.deployment["schedules"] = [{"id": str(uuid4()), "active": True}]
            return result

        self.assertEqual(probe.inspect_upgrade(changing, NAME)["status"], "UNKNOWN")

    def test_database_and_remote_errors_are_unknown_and_redacted(self):
        self.read_database.side_effect = RuntimeError("private database password")
        result = self.inspect()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(self.calls, [])
        self.read_database.side_effect = lambda: self.database

        def unavailable(*args, **kwargs):
            raise OSError("private network credential")

        result = probe.inspect_upgrade(unavailable, NAME)
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertNotIn("private", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
