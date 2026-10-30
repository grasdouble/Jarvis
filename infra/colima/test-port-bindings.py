#!/usr/bin/env python3
"""Regression tests for Docker container host-port publication checks."""
import importlib.util
from pathlib import Path


module_path = Path(__file__).with_name("check-port-bindings.py")
spec = importlib.util.spec_from_file_location("check_port_bindings", module_path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


cases = [
    ("loopback publication", [{"HostConfig": {"PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5432"}]}}}], False),
    ("absent bindings", [{"HostConfig": {}}], True),
    ("null bindings", [{"HostConfig": {"PortBindings": None}}], True),
    ("empty bindings", [{"HostConfig": {"PortBindings": {}}}], True),
]
for name, containers, accepted in cases:
    try:
        checker.check(containers)
    except ValueError:
        actual = False
    else:
        actual = True
    if actual != accepted:
        raise SystemExit(f"{name}: expected accepted={accepted}, got accepted={actual}")
print("Docker port-binding tests passed.")
