#!/usr/bin/env python3
"""Reject any Docker host port publication in container inspect output."""
import json
import sys


def check(containers):
    for container in containers:
        bindings = container.get("HostConfig", {}).get("PortBindings") or {}
        for port, mappings in bindings.items():
            for binding in mappings or []:
                raise ValueError(f"published host port: {port} -> {binding}")


if __name__ == "__main__":
    try:
        check(json.load(sys.stdin))
    except ValueError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
