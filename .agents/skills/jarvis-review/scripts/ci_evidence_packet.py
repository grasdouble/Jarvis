#!/usr/bin/env python3
"""Create and validate sanitized, revision-bound CI evidence packets.

Packets are supplied data; this module performs no GitHub or credential access.
The SHA-256 digest detects packet-content changes but is not a signature.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
_SHA = re.compile(r"^[0-9a-f]{40}$")
_RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
_SECRET = re.compile(
    r"(?i)(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{20,}|"
    r"\bgithub_pat_[A-Za-z0-9_]{20,}|\bBearer\s+\S+|\b(?:token|secret|password)\s*[:=])"
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

_TOP_KEYS = {
    "schema_version", "repository", "pull_request_number", "pull_request_url", "base_sha", "head_sha",
    "run", "jobs", "checks", "provenance", "integrity_sha256",
}
_RUN_KEYS = {
    "id", "workflow_id", "check_suite_id", "pull_request_number", "base_sha", "head_sha",
    "workflow", "event", "conclusion", "created_at", "updated_at", "url",
}
_JOB_KEYS = {"name", "conclusion", "started_at", "completed_at", "url"}
_CHECK_KEYS = {"id", "check_suite_id", "name", "conclusion", "evaluated_sha", "started_at", "completed_at", "url"}
_PROVENANCE_KEYS = {"retrieved_by", "method", "retrieved_at"}
_CONCLUSIONS = {
    "success", "failure", "cancelled", "skipped", "neutral", "timed_out",
    "action_required", "stale", "startup_failure", "unknown",
}


class PacketError(ValueError):
    """Packet is malformed, unsafe, stale, incomplete, or non-qualifying."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _exact_keys(value: Any, keys: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise PacketError(f"{label} must contain exactly: {', '.join(sorted(keys))}")
    return value


def _text(value: Any, label: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise PacketError(f"{label} must be a non-empty string")
    if _CONTROL.search(value) or _SECRET.search(value):
        raise PacketError(f"{label} contains unsafe content")
    return value.strip()


def _timestamp(value: Any, label: str) -> str:
    text = _text(value, label)
    if not _RFC3339_UTC.fullmatch(text):
        raise PacketError(f"{label} must be a UTC RFC 3339 timestamp ending in Z")
    try:
        datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError as exc:
        raise PacketError(f"{label} must be a UTC RFC 3339 timestamp") from exc
    return text


def _timestamp_instant(text: str) -> tuple[datetime, Decimal]:
    """Return an exact UTC instant key for an already validated timestamp."""
    seconds = datetime.fromisoformat(text[:19] + "+00:00")
    fraction = Decimal("0." + text[20:-1]) if "." in text else Decimal(0)
    return seconds, fraction


def _url(value: Any, label: str) -> str:
    text = _text(value, label)
    parsed = urlsplit(text)
    if (
        parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username
        or parsed.password or parsed.query or parsed.fragment or not parsed.path.startswith("/")
    ):
        raise PacketError(f"{label} must be a credential-free HTTPS github.com URL without query or fragment")
    return text


def _conclusion(value: Any, label: str) -> str:
    text = _text(value, label)
    if text not in _CONCLUSIONS:
        raise PacketError(f"{label} is not a recognized conclusion")
    return text


def _normalize(payload: Mapping[str, Any]) -> dict[str, Any]:
    packet = dict(_exact_keys(payload, _TOP_KEYS - {"integrity_sha256"}, "packet"))
    if packet["schema_version"] != SCHEMA_VERSION:
        raise PacketError("unsupported schema_version")
    packet["repository"] = _text(packet["repository"], "repository")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", packet["repository"]):
        raise PacketError("repository must use owner/name form")
    number = packet["pull_request_number"]
    if type(number) is not int or number <= 0:
        raise PacketError("pull_request_number must be a positive integer")
    packet["pull_request_url"] = _url(packet["pull_request_url"], "pull_request_url")
    expected_pr_url = f"https://github.com/{packet['repository']}/pull/{number}"
    if packet["pull_request_url"] != expected_pr_url:
        raise PacketError("pull_request_url must be the canonical URL for the packet repository and PR")
    for key in ("base_sha", "head_sha"):
        if not isinstance(packet[key], str) or not _SHA.fullmatch(packet[key]):
            raise PacketError(f"{key} must be a full lowercase 40-character commit SHA")

    run = dict(_exact_keys(packet["run"], _RUN_KEYS, "run"))
    if type(run["id"]) is not int or run["id"] <= 0:
        raise PacketError("run.id must be a positive integer")
    if type(run["check_suite_id"]) is not int or run["check_suite_id"] <= 0:
        raise PacketError("run.check_suite_id must be a positive integer")
    if type(run["workflow_id"]) is not int or run["workflow_id"] <= 0:
        raise PacketError("run.workflow_id must be a positive integer")
    if type(run["pull_request_number"]) is not int or run["pull_request_number"] <= 0:
        raise PacketError("run.pull_request_number must be a positive integer")
    for key in ("base_sha", "head_sha"):
        if not isinstance(run[key], str) or not _SHA.fullmatch(run[key]):
            raise PacketError(f"run.{key} must be a full lowercase 40-character commit SHA")
    for key in ("workflow", "event"):
        run[key] = _text(run[key], f"run.{key}")
    run["conclusion"] = _conclusion(run["conclusion"], "run.conclusion")
    for key in ("created_at", "updated_at"):
        run[key] = _timestamp(run[key], f"run.{key}")
    run["url"] = _url(run["url"], "run.url")
    packet["run"] = run

    for collection, keys in (("jobs", _JOB_KEYS), ("checks", _CHECK_KEYS)):
        rows = packet[collection]
        if not isinstance(rows, list) or not rows:
            raise PacketError(f"{collection} must be a non-empty array")
        normalized = []
        seen: set[str] = set()
        for index, row_value in enumerate(rows):
            label = f"{collection}[{index}]"
            row = dict(_exact_keys(row_value, keys, label))
            row["name"] = _text(row["name"], f"{label}.name")
            if row["name"] in seen:
                raise PacketError(f"{collection} names must be unique")
            seen.add(row["name"])
            row["conclusion"] = _conclusion(row["conclusion"], f"{label}.conclusion")
            if collection == "checks":
                for key in ("id", "check_suite_id"):
                    if type(row[key]) is not int or row[key] <= 0:
                        raise PacketError(f"{label}.{key} must be a positive integer")
                if not isinstance(row["evaluated_sha"], str) or not _SHA.fullmatch(row["evaluated_sha"]):
                    raise PacketError(f"{label}.evaluated_sha must be a full lowercase commit SHA")
            row["started_at"] = _timestamp(row["started_at"], f"{label}.started_at")
            row["completed_at"] = _timestamp(row["completed_at"], f"{label}.completed_at")
            if _timestamp_instant(row["completed_at"]) < _timestamp_instant(row["started_at"]):
                raise PacketError(f"{label} completes before it starts")
            row["url"] = _url(row["url"], f"{label}.url")
            normalized.append(row)
        packet[collection] = normalized

    provenance = dict(_exact_keys(packet["provenance"], _PROVENANCE_KEYS, "provenance"))
    if provenance["retrieved_by"] != "coordinator" or provenance["method"] != "reviewed-github-app":
        raise PacketError("provenance must state coordinator retrieval through reviewed-github-app")
    provenance["retrieved_at"] = _timestamp(provenance["retrieved_at"], "provenance.retrieved_at")
    packet["provenance"] = provenance
    return packet


def canonical_json(value: Any) -> str:
    """Serialize deterministically, refusing non-JSON values and NaN."""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise PacketError("packet is not safely JSON-serializable") from exc


def create_packet(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize and hash supplied coordinator data; never performs live collection."""
    packet = _normalize(payload)
    packet["integrity_sha256"] = hashlib.sha256(canonical_json(packet).encode("utf-8")).hexdigest()
    return packet


def serialize_packet(packet: Mapping[str, Any]) -> str:
    """Validate the content hash before deterministic serialization."""
    if not isinstance(packet, dict) or set(packet) != _TOP_KEYS:
        raise PacketError("packet must contain the complete schema including integrity_sha256")
    digest = packet.get("integrity_sha256")
    body = {key: value for key, value in packet.items() if key != "integrity_sha256"}
    if _normalize(body) != body:
        raise PacketError("packet content is not in normalized sanitized form")
    expected_digest = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or digest != expected_digest:
        raise PacketError("integrity_sha256 mismatch")
    return canonical_json(packet)


def parse_packet(serialized: str) -> dict[str, Any]:
    try:
        packet = json.loads(serialized, object_pairs_hook=_unique_object)
    except (TypeError, ValueError) as exc:
        raise PacketError("packet is not valid JSON") from exc
    serialize_packet(packet)
    return packet


def validate_packet(packet: Mapping[str, Any], expected: Mapping[str, Any]) -> None:
    """Fail closed unless packet identity, completeness, integrity and checks qualify."""
    serialized = serialize_packet(packet)
    checked = parse_packet(serialized)
    identity = {
        "repository": checked["repository"],
        "pull_request_number": checked["pull_request_number"],
        "pull_request_url": checked["pull_request_url"],
        "base_sha": checked["base_sha"],
        "head_sha": checked["head_sha"],
        "run_id": checked["run"]["id"],
        "workflow": checked["run"]["workflow"],
        "event": checked["run"]["event"],
    }
    if (
        checked["run"]["pull_request_number"] != checked["pull_request_number"]
        or checked["run"]["base_sha"] != checked["base_sha"]
        or checked["run"]["head_sha"] != checked["head_sha"]
    ):
        raise PacketError("workflow run is not bound to the packet PR/base/head identity")
    identity_keys = set(identity)
    required_keys = {"required_jobs", "required_checks"}
    if not isinstance(expected, Mapping) or not identity_keys | required_keys <= set(expected):
        raise PacketError("expected identity must include exact identity and required job/check names")
    if any(expected.get(k) != v for k, v in identity.items()):
        raise PacketError("packet identity does not match the expected repository/PR/revision/run/workflow/event")
    for field, collection in (("required_jobs", "jobs"), ("required_checks", "checks")):
        required = expected[field]
        if not isinstance(required, (list, tuple)) or not required or any(not isinstance(name, str) or not name for name in required):
            raise PacketError(f"{field} must be a non-empty list of names")
        present = {row["name"] for row in checked[collection]}
        if not set(required) <= present:
            raise PacketError(f"{collection} are incomplete; required evidence is missing")
    if checked["run"]["conclusion"] != "success":
        raise PacketError("workflow run did not conclude successfully")
    for collection in ("jobs", "checks"):
        if any(row["conclusion"] != "success" for row in checked[collection]):
            raise PacketError(f"{collection} include failed, skipped, or non-success evidence")
    if any(check["evaluated_sha"] != checked["head_sha"] for check in checked["checks"]):
        raise PacketError("check evidence is not bound to the packet head SHA")
    if any(check["check_suite_id"] != checked["run"]["check_suite_id"] for check in checked["checks"]):
        raise PacketError("check evidence is not bound to the packet workflow run's check suite")
    if len({check["id"] for check in checked["checks"]}) != len(checked["checks"]):
        raise PacketError("check run IDs must be unique")
