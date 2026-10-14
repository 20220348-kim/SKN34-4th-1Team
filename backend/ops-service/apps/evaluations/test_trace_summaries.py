"""실행 목록의 모델 호출 요약은 하위 호출을 중복 없이, 누락을 숨기지 않고 집계한다."""

import json
from datetime import timedelta
from unittest.mock import patch

from django.test import SimpleTestCase

from . import trace_client
from .test_traces import NOW, TRACE_ID, row


def model_call(identifier, parent, *, trace_id=TRACE_ID, **changes):
    return row(
        **{
            "id": identifier,
            "traceId": trace_id,
            "isRootObservation": False,
            "parentObservationId": parent,
            "type": "GENERATION",
            "model": "gpt-6-luna",
            "totalCost": 0.1,
            **changes,
        }
    )


@patch("apps.evaluations.trace_client.read_page")
class TraceCallSummaryTests(SimpleTestCase):
    def test_empty_list_does_not_call_langfuse(self, read_page):
        self.assertEqual(trace_client.read_call_summaries([]), {})
        read_page.assert_not_called()

    def test_all_listed_traces_share_one_query_without_io_or_time_filter(self, read_page):
        roots = [row(id="root-a"), row(id="root-b", traceId="other-trace")]
        read_page.return_value = (
            [
                *roots,
                model_call("call-a", "root-a"),
                model_call("call-b", "root-b", trace_id="other-trace"),
            ],
            None,
        )

        summaries = trace_client.read_call_summaries(roots)

        read_page.assert_called_once()
        query = read_page.call_args.args[0]
        self.assertEqual(query["limit"], 1000)
        self.assertEqual(set(query["fields"].split(",")), {"basic", "model", "usage"})
        filters = json.loads(query["filter"])
        self.assertEqual(len(filters), 1)
        self.assertEqual(filters[0]["column"], "traceId")
        self.assertEqual(filters[0]["operator"], "any of")
        self.assertEqual(set(filters[0]["value"]), {TRACE_ID, "other-trace"})
        for forbidden in ("fromStartTime", "toStartTime", "name", "isRootObservation"):
            self.assertNotIn(forbidden, query)
        self.assertLessEqual(read_page.call_args.kwargs["timeout"], 8)
        self.assertEqual(summaries["root-a"]["call_count"], 1)
        self.assertEqual(summaries["root-b"]["call_count"], 1)

    def test_same_trace_calls_belong_to_the_nearest_logical_root(self, read_page):
        roots = [row(id="core"), row(id="ai", parentObservationId="core")]
        read_page.return_value = (
            [
                *roots,
                row(id="stage", isRootObservation=False, parentObservationId="ai"),
                model_call("core-call", "core", model="model-a", totalCost=0.1),
                model_call("ai-call", "stage", model="model-b", totalCost=0.2),
            ],
            None,
        )

        summaries = trace_client.read_call_summaries(roots)

        self.assertEqual(summaries["core"]["models"], ["model-a"])
        self.assertEqual(summaries["core"]["recorded_cost"], 0.1)
        self.assertEqual(summaries["ai"]["models"], ["model-b"])
        self.assertEqual(summaries["ai"]["recorded_cost"], 0.2)
        self.assertEqual(sum(item["call_count"] for item in summaries.values()), 2)

    def test_logical_root_outside_list_keeps_its_calls_out_of_parent_summary(self, read_page):
        root = row(id="visible-root")
        read_page.return_value = (
            [
                root,
                row(id="off-page-root", parentObservationId="visible-root"),
                model_call("off-page-call", "off-page-root", totalCost=9),
                model_call("visible-call", "visible-root", totalCost=0.2),
            ],
            None,
        )

        summaries = trace_client.read_call_summaries([root])

        self.assertEqual(set(summaries), {"visible-root"})
        self.assertEqual(summaries["visible-root"]["call_count"], 1)
        self.assertEqual(summaries["visible-root"]["recorded_cost"], 0.2)

    def test_generation_root_counts_itself_once(self, read_page):
        root = row(id="generation-root", type="GENERATION", model="model-a", totalCost=0.4)
        read_page.return_value = ([root], None)

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["models"], ["model-a"])
        self.assertEqual(summary["call_count"], 1)
        self.assertEqual(summary["recorded_cost"], 0.4)

    def test_models_are_unique_sorted_and_include_embedding_calls(self, read_page):
        root = row()
        read_page.return_value = (
            [
                root,
                model_call("generation-a", root["id"], model="model-z"),
                model_call("generation-b", root["id"], model="model-z"),
                model_call("embedding", root["id"], type="EMBEDDING", model="model-a"),
            ],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["models"], ["model-a", "model-z"])
        self.assertEqual(summary["call_count"], 3)
        self.assertEqual(summary["missing_model_count"], 0)
        self.assertEqual(summary["recorded_cost"], 0.3)
        self.assertEqual(summary["status"], "complete")

    def test_missing_cost_does_not_become_zero_or_hide_recorded_subtotal(self, read_page):
        root = row()
        for costs, expected, missing in (
            ([None, None], None, 2),
            ([0.2, None], 0.2, 1),
            ([0], 0, 0),
        ):
            with self.subTest(costs=costs):
                read_page.return_value = (
                    [
                        root,
                        *[
                            model_call(f"call-{index}", root["id"], totalCost=cost)
                            for index, cost in enumerate(costs)
                        ],
                    ],
                    None,
                )

                summary = trace_client.read_call_summaries([root])[root["id"]]

                self.assertEqual(summary["recorded_cost"], expected)
                self.assertEqual(summary["missing_cost_count"], missing)
                self.assertEqual(summary["call_count"], len(costs))

    def test_missing_model_is_counted_separately_from_known_models(self, read_page):
        root = row()
        read_page.return_value = (
            [
                root,
                model_call("known", root["id"]),
                model_call("missing", root["id"], model=None),
                model_call("empty", root["id"], model=""),
            ],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["models"], ["gpt-6-luna"])
        self.assertEqual(summary["missing_model_count"], 2)
        self.assertEqual(summary["call_count"], 3)

    def test_span_metrics_are_not_added_to_model_call_cost(self, read_page):
        root = row(model="span-metadata-model", totalCost=5)
        read_page.return_value = ([root, model_call("call", root["id"], totalCost=0.2)], None)

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["models"], ["gpt-6-luna"])
        self.assertEqual(summary["recorded_cost"], 0.2)
        self.assertEqual(root["model"], "span-metadata-model")
        self.assertEqual(root["totalCost"], 5)

    def test_no_model_calls_has_no_recorded_cost(self, read_page):
        root = row()
        read_page.return_value = ([root], None)

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(
            summary,
            {
                "models": [],
                "call_count": 0,
                "missing_model_count": 0,
                "recorded_cost": None,
                "missing_cost_count": 0,
                "status": "complete",
            },
        )

    def test_running_intermediate_stage_is_partial_before_model_call_is_recorded(self, read_page):
        root = row()
        read_page.return_value = (
            [
                root,
                row(
                    id="running",
                    parentObservationId=root["id"],
                    isRootObservation=False,
                    endTime=None,
                ),
            ],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["call_count"], 0)
        self.assertIsNone(summary["recorded_cost"])

    def test_identical_rows_across_pages_are_counted_once(self, read_page):
        root = row()
        call = model_call("call", root["id"])
        read_page.side_effect = [([root, call], "next-page"), ([dict(call)], None)]

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["call_count"], 1)
        self.assertEqual(summary["recorded_cost"], 0.1)
        self.assertEqual(summary["status"], "complete")
        self.assertEqual(read_page.call_args_list[1].args[0]["cursor"], "next-page")

    def test_conflicting_duplicate_is_rejected(self, read_page):
        root = row()
        call = model_call("call", root["id"])
        read_page.side_effect = [([root, call], "next-page"), ([{**call, "totalCost": 2}], None)]

        with self.assertRaises(trace_client.LangfuseUnavailable):
            trace_client.read_call_summaries([root])

    def test_unrequested_trace_is_rejected(self, read_page):
        root = row()
        read_page.return_value = (
            [root, model_call("call", root["id"], trace_id="unrequested-trace")],
            None,
        )

        with self.assertRaises(trace_client.LangfuseUnavailable):
            trace_client.read_call_summaries([root])

    def test_invalid_parent_and_cross_trace_parent_are_rejected(self, read_page):
        root = row(id="root-a")
        other = row(id="root-b", traceId="other-trace")
        for parent in ([], 4, "invalid parent", "root-b"):
            with self.subTest(parent=parent):
                read_page.return_value = ([root, other, model_call("call", parent)], None)
                with self.assertRaises(trace_client.LangfuseUnavailable):
                    trace_client.read_call_summaries([root, other])

    def test_invalid_model_call_cost_is_rejected(self, read_page):
        root = row()
        for cost in (-1, float("nan"), float("inf"), True, "0.2"):
            with self.subTest(cost=cost):
                read_page.return_value = (
                    [root, model_call("call", root["id"], totalCost=cost)],
                    None,
                )
                with self.assertRaises(trace_client.LangfuseUnavailable):
                    trace_client.read_call_summaries([root])

    def test_orphan_call_keeps_known_subtotal_but_marks_trace_partial(self, read_page):
        root = row()
        read_page.return_value = (
            [root, model_call("known", root["id"]), model_call("orphan", "missing-parent")],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["call_count"], 1)
        self.assertEqual(summary["recorded_cost"], 0.1)
        self.assertEqual(summary["status"], "partial")

    def test_cyclic_parent_chain_does_not_hang_or_claim_complete(self, read_page):
        root = row()
        read_page.return_value = (
            [
                root,
                row(id="cycle-a", isRootObservation=False, parentObservationId="cycle-b"),
                row(id="cycle-b", isRootObservation=False, parentObservationId="cycle-a"),
                model_call("call", "cycle-a"),
            ],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["call_count"], 0)
        self.assertIsNone(summary["recorded_cost"])

    def test_running_root_or_call_is_partial(self, read_page):
        for root_end, call_end in ((None, "2026-10-14T01:00:01Z"), ("2026-10-14T01:00:01Z", None)):
            with self.subTest(root_end=root_end, call_end=call_end):
                root = row(endTime=root_end)
                read_page.return_value = (
                    [root, model_call("call", root["id"], endTime=call_end)],
                    None,
                )

                summary = trace_client.read_call_summaries([root])[root["id"]]

                self.assertEqual(summary["status"], "partial")
                self.assertEqual(summary["call_count"], 1)

    def test_pagination_limit_returns_partial_instead_of_claiming_full_total(self, read_page):
        root = row()
        read_page.side_effect = [
            ([root, model_call("call-a", root["id"])], "page-2"),
            ([model_call("call-b", root["id"])], "page-3"),
            ([model_call("call-c", root["id"])], "page-4"),
        ]

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(read_page.call_count, 3)
        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["call_count"], 3)
        self.assertEqual(summary["recorded_cost"], 0.3)

    def test_elapsed_read_budget_stops_pagination_and_marks_partial(self, read_page):
        root = row()
        elapsed = [0]

        def fetch(*args, **kwargs):
            elapsed[0] = 9
            return [root, model_call("call", root["id"])], "next-page"

        read_page.side_effect = fetch
        with patch("apps.evaluations.trace_client.time.monotonic", side_effect=lambda: elapsed[0]):
            summary = trace_client.read_call_summaries([root])[root["id"]]

        read_page.assert_called_once()
        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["call_count"], 1)

    def test_repeated_cursor_is_rejected(self, read_page):
        root = row()
        read_page.side_effect = [([root], "repeat"), ([], "repeat")]

        with self.assertRaises(trace_client.LangfuseUnavailable):
            trace_client.read_call_summaries([root])

        self.assertEqual(read_page.call_count, 2)

    def test_transport_failure_does_not_report_a_partial_result_as_success(self, read_page):
        root = row()
        read_page.side_effect = [
            ([root, model_call("call", root["id"])], "next-page"),
            trace_client.LangfuseUnavailable(),
        ]

        with self.assertRaises(trace_client.LangfuseUnavailable):
            trace_client.read_call_summaries([root])

    def test_late_model_call_is_included_even_after_root_time_window(self, read_page):
        root = row()
        read_page.return_value = (
            [
                root,
                model_call(
                    "late-call",
                    root["id"],
                    startTime="2026-10-15T01:00:00Z",
                    endTime="2026-10-15T01:00:01Z",
                ),
            ],
            None,
        )

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["call_count"], 1)
        self.assertEqual(summary["recorded_cost"], 0.1)

    def test_root_missing_from_child_read_is_partial_instead_of_complete_zero(self, read_page):
        root = row()
        read_page.return_value = ([], None)

        summary = trace_client.read_call_summaries([root])[root["id"]]

        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["call_count"], 0)
        self.assertIsNone(summary["recorded_cost"])

    def test_list_exposes_summary_separately_and_preserves_its_cursor_and_root_metrics(
        self, read_page
    ):
        root = row(model="root-metadata", totalCost=4)
        read_page.side_effect = [
            ([root], "root-next-page"),
            ([root, model_call("call", root["id"], totalCost=0.2)], None),
        ]

        result = trace_client.read_roots(from_time=NOW - timedelta(days=7), to_time=NOW)

        self.assertEqual(read_page.call_count, 2)
        self.assertEqual(result["next_cursor"], "root-next-page")
        item = result["results"][0]
        self.assertEqual(item["model"], "root-metadata")
        self.assertEqual(item["total_cost"], 4)
        self.assertEqual(item["call_summary"]["models"], ["gpt-6-luna"])
        self.assertEqual(item["call_summary"]["recorded_cost"], 0.2)
        self.assertNotIn("cursor", read_page.call_args_list[1].args[0])

    def test_empty_list_response_does_not_add_a_child_query(self, read_page):
        read_page.return_value = ([], None)

        result = trace_client.read_roots(from_time=NOW - timedelta(days=7), to_time=NOW)

        self.assertEqual(result, {"results": [], "next_cursor": None})
        read_page.assert_called_once()
