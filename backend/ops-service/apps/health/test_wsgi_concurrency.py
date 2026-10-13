"""외부 응답을 기다리는 요청이 관리자 세션의 서버 진입을 모두 막지 않아야 한다."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import ProxyHandler, build_opener

from django.test import SimpleTestCase


class WsgiConcurrencyTests(SimpleTestCase):
    def test_fast_request_completes_while_two_requests_wait_for_external_response(self):
        # 이미지에는 Dockerfile이 없으므로 컨테이너 검증 도구가 inspect한 실제 CMD를 전달한다.
        command_json = os.environ.get("OPS_TEST_GUNICORN_COMMAND")
        if command_json is None:
            dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile"
            self.assertTrue(
                dockerfile.is_file(),
                "WSGI tests require the checkout Dockerfile or the inspected image CMD "
                "in OPS_TEST_GUNICORN_COMMAND.",
            )
            command_json = next(
                line.removeprefix("CMD ")
                for line in dockerfile.read_text().splitlines()
                if line.startswith("CMD ")
            )
        command = json.loads(command_json)
        self.assertIsInstance(command, list)
        self.assertTrue(command and all(isinstance(argument, str) for argument in command))
        self.assertEqual(command[0], "gunicorn")
        with TemporaryDirectory(prefix="govbiz-wsgi-test-") as directory:
            root = Path(directory)
            (root / "fixture.py").write_text(
                "from pathlib import Path\n"
                "import time\n"
                "def app(environ, start_response):\n"
                "    if environ['PATH_INFO'] == '/held':\n"
                "        Path('entered-' + environ['QUERY_STRING']).touch()\n"
                "        deadline = time.monotonic() + 10\n"
                "        while not Path('release').exists():\n"
                "            if time.monotonic() >= deadline:\n"
                "                raise TimeoutError('Test request was not released')\n"
                "            time.sleep(0.01)\n"
                "    start_response('200 OK', [('Content-Length', '2')])\n"
                "    return [b'OK']\n"
            )
            with socket.socket() as listener, (root / "gunicorn.log").open("w+") as log:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                base = f"http://127.0.0.1:{listener.getsockname()[1]}"
                command[1] = "fixture:app"
                command[command.index("--bind") + 1] = f"fd://{listener.fileno()}"
                command[command.index("--worker-tmp-dir") + 1] = directory
                process = subprocess.Popen(
                    [sys.executable, "-m", *command],
                    cwd=directory,
                    env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
                    pass_fds=(listener.fileno(),),
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )

                def request(path, timeout=3):
                    # 로컬 테스트의 요청을 호스트 proxy로 보내지 않는다.
                    with build_opener(ProxyHandler({})).open(
                        base + path, timeout=timeout
                    ) as response:
                        return response.status, response.read()

                try:
                    self.assertEqual(request("/ready", timeout=5), (200, b"OK"))
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        held = [executor.submit(request, f"/held?{index}", 8) for index in (1, 2)]
                        try:
                            deadline = time.monotonic() + 3
                            while not all((root / f"entered-{index}").exists() for index in (1, 2)):
                                self.assertLess(
                                    time.monotonic(), deadline, "Held requests did not enter"
                                )
                                time.sleep(0.01)
                            # 시간 성능 기준 대신 release 전 응답 가능 여부를 검사한다.
                            self.assertEqual(request("/fast"), (200, b"OK"))
                            self.assertTrue(all(not future.done() for future in held))
                        finally:
                            (root / "release").touch()
                        self.assertEqual([future.result() for future in held], [(200, b"OK")] * 2)
                finally:
                    (root / "release").touch()
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGTERM)
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=3)
