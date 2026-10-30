import http.server
import importlib.util
import os
import pathlib
import socket
import socketserver
import subprocess
import tempfile
import textwrap
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

MODULE = pathlib.Path(__file__).with_name("ui-proxy.py")
spec = importlib.util.spec_from_file_location("ui_proxy", MODULE)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class ProxyTests(unittest.TestCase):
    class PartialResponse(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.recv(4096)
            self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\npartial")

    class Upstream(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"forwarded")

        def log_message(self, *_):
            pass

    def serve(self, target=None):
        server = proxy.make_server("127.0.0.1", 0, target or ("127.0.0.1", self.upstream.server_address[1]))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def setUp(self):
        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self.Upstream)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()

    def tearDown(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        self.upstream_thread.join()

    def test_forwards_tcp_requests(self):
        server, thread = self.serve()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/") as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b"forwarded")
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_missing_target_fails_closed_with_503(self):
        server, thread = self.serve(("127.0.0.1", 1))
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/", timeout=2)
            self.assertEqual(error.exception.code, 503)
            error.exception.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()
    def test_default_connection_uses_configured_upstream(self):
        server = proxy.make_server("127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            original_connect = socket.create_connection
            def reject_upstream(address, *args, **kwargs):
                if address == ("172.30.132.10", 3000):
                    raise OSError("unavailable")
                return original_connect(address, *args, **kwargs)
            with patch.object(proxy.socket, "create_connection", side_effect=reject_upstream) as connect:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/", timeout=2)
                self.assertEqual(error.exception.code, 503)
                error.exception.close()
            self.assertEqual(connect.call_args.args[0], ("172.30.132.10", 3000))
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_upstream_partial_response_is_not_followed_by_503(self):
        upstream = socketserver.ThreadingTCPServer(("127.0.0.1", 0), self.PartialResponse)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        server, thread = self.serve(("127.0.0.1", upstream.server_address[1]))
        try:
            with socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=2) as client:
                client.sendall(b"GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
                client.settimeout(2)
                received = b""
                while chunk := client.recv(4096):
                    received += chunk
            self.assertIn(b"HTTP/1.1 200 OK", received)
            self.assertIn(b"partial", received)
            self.assertNotIn(b"HTTP/1.1 503", received)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_listener_is_loopback_and_static_target_matches_compose(self):
        server = proxy.make_server("127.0.0.1", 0)
        try:
            self.assertEqual(server.server_address[0], "127.0.0.1")
        finally:
            server.server_close()
        self.assertEqual(proxy.UPSTREAM_HOST, "172.30.132.10")
        self.assertEqual(proxy.UPSTREAM_PORT, 3000)
        with self.assertRaises(ValueError):
            proxy.make_server("0.0.0.0", 0)



class WrapperLifecycleTests(unittest.TestCase):
    def run_wrapper(self, operation, fail_compose=False, image_id=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            log = root / "calls"
            fake_colima = fake_bin / "colima"
            fake_colima.write_text(textwrap.dedent("""\
                #!/bin/sh
                printf '%s\\n' "$*" >> "$CALL_LOG"
                if [ "$1" = ssh ]; then
                  shift 4
                  if [ "$1" = getent ]; then printf 'docker:x:999:\\n'; exit 0; fi
                  case " $* " in
                    *" docker compose "*) [ "${FAIL_COMPOSE:-0}" = 0 ] || exit 12 ;;
                  esac
                fi
                """))
            fake_colima.chmod(0o755)
            result = subprocess.run(
                ["bash", str(pathlib.Path(__file__).with_name("compose.sh")), operation],
                env={**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "CALL_LOG": str(log),
                     "JARVIS_APP_IMAGE": image_id or ("sha256:" + "a" * 64),
                     "FAIL_COMPOSE": "1" if fail_compose else "0"},
                capture_output=True, text=True,
            )
            return result, log.read_text().splitlines() if log.exists() else []

    def test_wrapper_rejects_registry_references_before_colima(self):
        for image in ("registry.example/jarvis:latest", "registry.example/jarvis@sha256:" + "a" * 64):
            with self.subTest(image=image):
                result, calls = self.run_wrapper("ps", image_id=image)
                self.assertEqual(result.returncode, 2)
                self.assertIn("must be a local Docker image ID", result.stderr)
                self.assertEqual(calls, [])



    def test_local_image_id_is_forwarded_to_guest_compose(self):
        image_id = "sha256:" + "b" * 64
        result, calls = self.run_wrapper("ps", image_id=image_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        compose = next(call for call in calls if "docker compose" in call)
        self.assertIn(f"JARVIS_APP_IMAGE={image_id}", compose)

    def test_up_starts_proxy_only_after_compose_up_succeeds(self):
        result, calls = self.run_wrapper("up")
        self.assertEqual(result.returncode, 0, result.stderr)
        compose = next(i for i, call in enumerate(calls) if "docker compose" in call)
        reload = next(i for i, call in enumerate(calls) if "daemon-reload" in call)
        enable = next(i for i, call in enumerate(calls) if "systemctl enable jarvis-ui-proxy.service" in call)
        restart = next(i for i, call in enumerate(calls) if "systemctl restart jarvis-ui-proxy.service" in call)
        self.assertLess(compose, reload)
        self.assertLess(reload, enable)
        self.assertLess(enable, restart)

    def test_up_failure_does_not_start_proxy(self):
        _, calls = self.run_wrapper("up", fail_compose=True)
        self.assertFalse(any("daemon-reload" in call for call in calls))
        self.assertFalse(any("systemctl enable jarvis-ui-proxy.service" in call for call in calls))
        self.assertFalse(any("systemctl restart jarvis-ui-proxy.service" in call for call in calls))

    def test_down_stops_proxy_before_compose_down(self):
        result, calls = self.run_wrapper("down")
        self.assertEqual(result.returncode, 0, result.stderr)
        disable = next(i for i, call in enumerate(calls) if "disable --now jarvis-ui-proxy.service" in call)
        compose = next(i for i, call in enumerate(calls) if "docker compose" in call)
        self.assertLess(disable, compose)

    def test_service_is_unprivileged_address_family_restricted_and_loopback_only(self):
        service = pathlib.Path(__file__).with_name("ui-proxy.service").read_text()
        self.assertIn("--listen 127.0.0.1 --port 3000", service)
        self.assertIn("DynamicUser=true", service)
        self.assertIn("RestrictAddressFamilies=AF_INET", service)
        self.assertNotIn("User=root", service)
        self.assertNotIn("AF_UNIX", service)
        self.assertIn("Restart=on-failure", service)
        self.assertIn("WantedBy=multi-user.target", service)


if __name__ == "__main__":
    unittest.main()
