"""Both forwards must belong to our child processes, including startup failures."""

import io
import socket
import subprocess
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

    def test_invalid_or_duplicate_ports_fail_before_socket_or_process_access(self):
        for core, ops in (
            (0, 18001),
            (1023, 18001),
            (65536, 18001),
            (18080, -1),
            (True, 18001),
            ("18080", 18001),
            (18080, 18080),
        ):
            with (
                self.subTest(core=core, ops=ops),
                patch.object(web.socket, "socket") as listener,
                patch.object(web.subprocess, "Popen") as start,
                self.assertRaises(ValueError),
                web.forwards(["kubectl"], core_port=core, ops_port=ops),
            ):
                self.fail("must not yield")
            listener.assert_not_called()
            start.assert_not_called()

    def test_custom_ports_control_bindings_forward_commands_and_readiness(self):
        children = [Mock(), Mock()]
        for child in children:
            child.poll.return_value = None
        logs = [
            io.StringIO("Forwarding from 127.0.0.1:28080 -> 8080\n"),
            io.StringIO("Forwarding from 127.0.0.1:28001 -> 8000\n"),
        ]
        listeners = [Mock(), Mock()]
        with (
            patch.object(web.socket, "socket", side_effect=listeners),
            patch.object(web.tempfile, "TemporaryFile", side_effect=logs),
            patch.object(web.subprocess, "Popen", side_effect=children) as start,
            web.forwards(["kubectl"], core_port=28080, ops_port=28001),
        ):
            pass
        for listener, port in zip(listeners, (28080, 28001)):
            listener.bind.assert_called_once_with(("127.0.0.1", port))
            listener.close.assert_called_once()
        for call, (service, local, remote) in zip(
            start.call_args_list, web.forward_targets(28080, 28001)
        ):
            command = call.args[0]
            self.assertEqual(command[-1], f"{local}:{remote}")
            self.assertIn("deployment/" + service, command)
            self.assertEqual(command[command.index("--address") + 1], "127.0.0.1")
        for child in children:
            child.terminate.assert_called_once()

    def test_actual_busy_custom_port_is_preserved(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            ops_port = 28001 if port != 28001 else 28002
            with (
                patch.object(web.subprocess, "Popen") as start,
                self.assertRaisesRegex(ValueError, f"port {port} is occupied"),
                web.forwards(["kubectl"], core_port=port, ops_port=ops_port),
            ):
                self.fail("must not yield")
            start.assert_not_called()
            self.assertNotEqual(occupied.fileno(), -1)
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                connection, _ = occupied.accept()
                connection.close()

    def test_timeout_does_not_accept_default_port_logs_for_custom_ports(self):
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
            patch.object(web.subprocess, "Popen", side_effect=children),
            patch.object(web.time, "monotonic", side_effect=[0, 91]),
            self.assertRaisesRegex(ValueError, "timed out"),
            web.forwards(["kubectl"], core_port=28080, ops_port=28001),
        ):
            self.fail("must not yield")
        for child in children:
            child.terminate.assert_called_once()
            child.wait.assert_called_once()

    def test_termination_timeout_kills_only_owned_child(self):
        child = Mock()
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired("kubectl", 5), None]
        with (
            patch.object(web, "check_ports"),
            patch.object(
                web.subprocess, "Popen", side_effect=[child, OSError("spawn")]
            ),
            self.assertRaises(OSError),
            web.forwards(["kubectl"], ops_port=28001),
        ):
            self.fail("must not yield")
        child.terminate.assert_called_once()
        child.kill.assert_called_once()

    def test_serve_prints_matching_vite_ports_and_cleans_up_on_interrupt(self):
        with (
            patch.object(web, "forwards") as forwards,
            patch.object(web, "ensure_running", side_effect=KeyboardInterrupt),
            patch("sys.stdout", new_callable=io.StringIO) as output,
            self.assertRaises(KeyboardInterrupt),
        ):
            web.serve(["kubectl"], core_port=28080, ops_port=28001)
        forwards.assert_called_once_with(["kubectl"], core_port=28080, ops_port=28001)
        self.assertIn("K8S_CORE_PORT=28080 K8S_OPS_PORT=28001", output.getvalue())
        forwards.return_value.__exit__.assert_called_once()

    def test_forward_health_detects_later_exit(self):
        child = Mock()
        child.poll.return_value = 0
        with self.assertRaisesRegex(ValueError, "forward stopped"):
            web.ensure_running([child])


if __name__ == "__main__":
    unittest.main()
