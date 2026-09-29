"""Both forwards must belong to our child processes, including startup failures."""

import io
import unittest
from unittest.mock import Mock, patch

import fork_web as web


class WebForwardTests(unittest.TestCase):
    def test_busy_port_prevents_start_and_does_not_terminate_other_processes(self):
        listener = Mock()
        listener.bind.side_effect = OSError("address in use")
        with (
            patch.object(web.socket, "socket", return_value=listener),
            patch.object(web.subprocess, "Popen") as start,
            self.assertRaisesRegex(ValueError, "occupied"),
            web.forwards(["kubectl"]),
        ):
            self.fail("must not yield")
        listener.close.assert_called_once()
        start.assert_not_called()

    def test_both_forward_targets_and_loopback_binding_are_explicit(self):
        children = [Mock(), Mock()]
        for child in children:
            child.poll.return_value = None
        logs = [
            io.StringIO("Forwarding from 127.0.0.1:18080 -> 8080\n"),
            io.StringIO("Forwarding from 127.0.0.1:18001 -> 8000\n"),
        ]
        with (
            patch.object(web, "check_ports"),
            patch.object(web.tempfile, "TemporaryFile", side_effect=logs),
            patch.object(web.subprocess, "Popen", side_effect=children) as start,
        ):
            with web.forwards(
                ["kubectl", "--context", "owned", "-n", "govbiz-msa"]
            ) as processes:
                self.assertEqual(processes, children)
            for call, (service, local, remote) in zip(
                start.call_args_list, web.FORWARDS
            ):
                command = call.args[0]
                self.assertIn("owned", command)
                self.assertIn("deployment/" + service, command)
                self.assertEqual(command[-1], f"{local}:{remote}")
                self.assertEqual(command[command.index("--address") + 1], "127.0.0.1")
        for child in children:
            child.terminate.assert_called_once()
            child.wait.assert_called_once()

    def test_one_dead_forward_stops_the_other(self):
        children = [Mock(), Mock()]
        children[0].poll.return_value = None
        children[1].poll.return_value = 1
        with (
            patch.object(web, "check_ports"),
            patch.object(web.subprocess, "Popen", side_effect=children),
            self.assertRaisesRegex(ValueError, "forward stopped"),
            web.forwards(["kubectl"]),
        ):
            self.fail("must not yield")
        children[0].terminate.assert_called_once()
        children[1].terminate.assert_not_called()

    def test_second_spawn_failure_cleans_up_first(self):
        first = Mock()
        first.poll.return_value = None
        with (
            patch.object(web, "check_ports"),
            patch.object(
                web.subprocess, "Popen", side_effect=[first, OSError("spawn")]
            ),
            self.assertRaises(OSError),
            web.forwards(["kubectl"]),
        ):
            self.fail("must not yield")
        first.terminate.assert_called_once()

    def test_forward_health_detects_later_exit(self):
        child = Mock()
        child.poll.return_value = 0
        with self.assertRaisesRegex(ValueError, "forward stopped"):
            web.ensure_running([child])


if __name__ == "__main__":
    unittest.main()
