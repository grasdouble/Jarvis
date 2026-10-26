#!/usr/bin/env python3
"""Typed, fixed-route egress adapter. It never accepts a URL or proxy request."""

import base64
import hmac
import http.client
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 1_048_576
MAX_RESPONSE = 8_388_608
ROUTE = "/v1/chat/completions"
PROVIDER_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")


def load_allowlist(path="/etc/jarvis/egress.json"):
    value = json.loads(Path(path).read_text())
    if (not isinstance(value, dict) or set(value) != {"providers", "dispatch_enabled", "filterCapability"} or
            not isinstance(value["providers"], list) or value["dispatch_enabled"] is not False or
            value["providers"] != [] or
            not isinstance(value["filterCapability"], str) or not re.fullmatch(r"[a-fA-F0-9]{64}", value["filterCapability"])):
        raise ValueError("invalid trusted egress configuration")
    providers = {}
    for entry in value["providers"]:
        if not isinstance(entry, dict) or set(entry) != {"id", "host", "port", "protocol", "route", "api_key"}:
            raise ValueError("invalid provider allowlist entry")
        if (not isinstance(entry["id"], str) or not PROVIDER_ID.fullmatch(entry["id"]) or
                not isinstance(entry["host"], str) or not entry["host"] or
                entry["protocol"] != "https" or entry["port"] != 443 or entry["route"] != ROUTE or
                not isinstance(entry["api_key"], str) or not entry["api_key"]):
            raise ValueError("provider allowlist entry is not an authorized fixed HTTPS route")
        if entry["id"] in providers:
            raise ValueError("duplicate provider identity")
        providers[entry["id"]] = entry
    return providers, value["filterCapability"]


def dispatch(provider_id, route, encoded_body, providers, opener=http.client.HTTPSConnection):
    if not isinstance(provider_id, str) or not PROVIDER_ID.fullmatch(provider_id) or route != ROUTE:
        raise ValueError("provider identity or route is not allowed")
    provider = providers.get(provider_id)
    if provider is None:
        raise PermissionError("provider is not allowlisted")
    body = base64.b64decode(encoded_body, validate=True)
    if not body or len(body) > MAX_BODY:
        raise ValueError("request body is outside the configured bound")
    connection = opener(provider["host"], provider["port"], timeout=30)
    try:
        connection.request("POST", ROUTE, body=body, headers={
            "authorization": "Bearer " + provider["api_key"],
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        })
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise PermissionError("provider redirects are denied")
        result = response.read(MAX_RESPONSE + 1)
        if len(result) > MAX_RESPONSE:
            raise ValueError("provider response exceeds the configured bound")
        return response.status, response.getheader("content-type", "application/octet-stream"), result
    finally:
        connection.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JarvisEgressFilter"

    def do_POST(self):
        if self.path != "/v1/dispatch" or self.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
            self.send_error(404)
            return
        if not self.server.capability or not hmac.compare_digest(
                self.headers.get("authorization", ""), "Bearer " + self.server.capability):
            self.send_error(403)
            return
        if not self.server.dispatch_enabled:
            self.send_error(503)
            return
        try:
            length = int(self.headers.get("content-length", "-1"))
            if length < 1 or length > MAX_BODY * 2:
                raise ValueError("invalid content length")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != {"providerId", "route", "body"}:
                raise ValueError("invalid typed dispatch request")
            status, content_type, response = dispatch(
                request["providerId"], request["route"], request["body"], self.server.providers)
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(response)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(response)
        except PermissionError:
            self.send_error(403)
        except Exception:
            self.send_error(502)

    def log_message(self, _format, *_args):
        return


def main():
    if sys.argv[1:] == ["--config-writer"]:
        # Trusted manager-only bootstrap mode. It has no network and accepts no input;
        # Docker Engine's fixed archive API writes the mounted config volume.
        threading.Event().wait()
        return
    if sys.argv[1:]:
        raise SystemExit("unsupported filter mode")
    providers, capability = load_allowlist()
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    server.providers = providers
    server.capability = capability
    server.dispatch_enabled = False
    server.serve_forever()


if __name__ == "__main__":
    main()
