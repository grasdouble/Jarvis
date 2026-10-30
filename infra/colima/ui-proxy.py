#!/usr/bin/env python3
"""Loopback-only guest-host TCP forwarder for the Compose API service."""

import argparse
import selectors
import socket
import socketserver
import sys

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 3000
UPSTREAM_HOST = "172.30.132.10"
UPSTREAM_PORT = 3000


def make_server(host, port, target=(UPSTREAM_HOST, UPSTREAM_PORT)):
    if host != LISTEN_HOST:
        raise ValueError("the UI proxy may bind only guest 127.0.0.1")
    if not 0 <= port <= 65535:
        raise ValueError("proxy port is outside the TCP range")



    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            response_started = False
            try:
                with socket.create_connection(target, timeout=5) as upstream:
                    self.request.settimeout(60)
                    upstream.settimeout(60)
                    sockets = (self.request, upstream)
                    with selectors.DefaultSelector() as selector:
                        for sock in sockets:
                            selector.register(sock, selectors.EVENT_READ)
                        while selector.get_map():
                            for key, _ in selector.select():
                                data = key.fileobj.recv(65536)
                                other = upstream if key.fileobj is self.request else self.request
                                if not data:
                                    selector.unregister(key.fileobj)
                                    try:
                                        other.shutdown(socket.SHUT_WR)
                                    except OSError:
                                        pass
                                    continue
                                if key.fileobj is upstream:
                                    response_started = True
                                other.sendall(data)
            except OSError as error:
                print(f"jarvis-ui-proxy: request failed closed: {error}", file=sys.stderr, flush=True)
                if not response_started:
                    try:
                        self.request.sendall(
                            b"HTTP/1.1 503 Service Unavailable\r\n"
                            b"Connection: close\r\nContent-Length: 0\r\n\r\n"
                        )
                    except OSError:
                        pass

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    return Server((host, port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default=LISTEN_HOST)
    parser.add_argument("--port", type=int, default=LISTEN_PORT)
    args = parser.parse_args()
    make_server(args.listen, args.port).serve_forever()


if __name__ == "__main__":
    main()
