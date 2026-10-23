import hashlib
import json
import unittest

from ci_evidence_packet import (
    PacketError,
    canonical_json,
    create_packet,
    parse_packet,
    serialize_packet,
    validate_packet,
)


BASE = "a" * 40
HEAD = "b" * 40
EXPECTED = {
    "repository": "grasdouble/Jarvis",
    "pull_request_number": 213,
    "pull_request_url": "https://github.com/grasdouble/Jarvis/pull/213",
    "base_sha": BASE,
    "head_sha": HEAD,
    "run_id": 987654321,
    "workflow": "Repository checks",
    "event": "pull_request",
    "required_jobs": ["Repository configuration"],
    "required_checks": ["Repository configuration"],
}


def payload():
    return {
        "schema_version": 1,
        "repository": EXPECTED["repository"],
        "pull_request_number": EXPECTED["pull_request_number"],
        "pull_request_url": EXPECTED["pull_request_url"],
        "base_sha": BASE,
        "head_sha": HEAD,
        "run": {
            "id": EXPECTED["run_id"],
            "workflow_id": 19,
            "check_suite_id": 222,
            "pull_request_number": EXPECTED["pull_request_number"],
            "base_sha": BASE,
            "head_sha": HEAD,
            "workflow": EXPECTED["workflow"],
            "event": EXPECTED["event"],
            "conclusion": "success",
            "created_at": "2026-10-23T10:00:00Z",
            "updated_at": "2026-10-23T10:05:00Z",
            "url": "https://github.com/grasdouble/Jarvis/actions/runs/987654321",
        },
        "jobs": [{
            "name": "Repository configuration",
            "conclusion": "success",
            "started_at": "2026-10-23T10:00:10Z",
            "completed_at": "2026-10-23T10:04:00Z",
            "url": "https://github.com/grasdouble/Jarvis/actions/runs/987654321/job/1",
        }],
        "checks": [{
            "id": 456,
            "check_suite_id": 222,
            "name": "Repository configuration",
            "conclusion": "success",
            "evaluated_sha": HEAD,
            "started_at": "2026-10-23T10:00:10Z",
            "completed_at": "2026-10-23T10:04:00Z",
            "url": "https://github.com/grasdouble/Jarvis/commit/" + HEAD + "/checks/1",
        }],
        "provenance": {
            "retrieved_by": "coordinator",
            "method": "reviewed-github-app",
            "retrieved_at": "2026-10-23T10:06:00Z",
        },
    }


class EvidencePacketTests(unittest.TestCase):
    def test_valid_packet_is_revision_bound_and_deterministic(self):
        packet = create_packet(payload())
        validate_packet(packet, EXPECTED)
        encoded = serialize_packet(packet)
        self.assertEqual(encoded, canonical_json(packet))
        self.assertEqual(parse_packet(encoded), packet)
        self.assertEqual(len(packet["integrity_sha256"]), 64)

    def test_hash_tampering_is_rejected(self):
        packet = create_packet(payload())
        packet["jobs"][0]["name"] = "changed"
        with self.assertRaisesRegex(PacketError, "integrity_sha256 mismatch"):
            serialize_packet(packet)

    def test_mismatched_expected_identity_is_rejected(self):
        packet = create_packet(payload())
        wrong = dict(EXPECTED, head_sha=BASE)
        with self.assertRaisesRegex(PacketError, "identity"):
            validate_packet(packet, wrong)

    def test_pull_request_url_is_required_validated_and_identity_bound(self):
        missing = payload()
        del missing["pull_request_url"]
        with self.assertRaises(PacketError):
            create_packet(missing)
        unsafe = payload()
        unsafe["pull_request_url"] += "?token=not-allowed"
        with self.assertRaises(PacketError):
            create_packet(unsafe)
        noncanonical = payload()
        noncanonical["pull_request_url"] = "https://github.com/another/repo/pull/213"
        with self.assertRaisesRegex(PacketError, "canonical"):
            create_packet(noncanonical)
        packet = create_packet(payload())
        wrong_url = dict(EXPECTED, pull_request_url="https://github.com/grasdouble/Jarvis/pull/214")
        with self.assertRaisesRegex(PacketError, "identity"):
            validate_packet(packet, wrong_url)

    def test_incomplete_and_unknown_schema_fields_fail_closed(self):
        incomplete = payload()
        del incomplete["checks"]
        with self.assertRaises(PacketError):
            create_packet(incomplete)
        extra = payload()
        extra["raw_logs"] = "must never be accepted"
        with self.assertRaises(PacketError):
            create_packet(extra)

    def test_required_job_and_check_completeness_is_checked(self):
        packet = create_packet(payload())
        missing = dict(EXPECTED, required_checks=["Secret scan"])
        with self.assertRaisesRegex(PacketError, "incomplete"):
            validate_packet(packet, missing)
        missing_requirements = {key: value for key, value in EXPECTED.items() if key != "required_jobs"}
        with self.assertRaisesRegex(PacketError, "expected identity"):
            validate_packet(packet, missing_requirements)

    def test_failed_and_skipped_jobs_or_checks_do_not_qualify(self):
        for collection, conclusion in (("jobs", "failure"), ("jobs", "skipped"), ("checks", "failure"), ("checks", "skipped")):
            candidate = payload()
            candidate[collection][0]["conclusion"] = conclusion
            with self.subTest(collection=collection, conclusion=conclusion):
                packet = create_packet(candidate)
                with self.assertRaisesRegex(PacketError, "non-success"):
                    validate_packet(packet, EXPECTED)

    def test_wrong_check_sha_and_non_success_run_do_not_qualify(self):
        candidate = payload()
        candidate["checks"][0]["evaluated_sha"] = BASE
        with self.assertRaisesRegex(PacketError, "head SHA"):
            validate_packet(create_packet(candidate), EXPECTED)
        candidate = payload()
        candidate["run"]["conclusion"] = "cancelled"
        with self.assertRaisesRegex(PacketError, "did not conclude"):
            validate_packet(create_packet(candidate), EXPECTED)

        candidate = payload()
        candidate["checks"][0]["check_suite_id"] = 999
        with self.assertRaisesRegex(PacketError, "check suite"):
            validate_packet(create_packet(candidate), EXPECTED)

        candidate = payload()
        candidate["run"]["pull_request_number"] = 214
        with self.assertRaisesRegex(PacketError, "not bound"):
            validate_packet(create_packet(candidate), EXPECTED)

    def test_secret_material_and_private_or_query_urls_are_rejected(self):
        candidate = payload()
        candidate["jobs"][0]["name"] = "Bearer abc123"
        with self.assertRaisesRegex(PacketError, "unsafe"):
            create_packet(candidate)
        candidate = payload()
        candidate["run"]["url"] = "https://github.com/grasdouble/Jarvis/actions/runs/1?token=secret"
        with self.assertRaisesRegex(PacketError, "unsafe|URL"):
            create_packet(candidate)
        candidate = payload()
        candidate["raw_logs"] = "-----BEGIN PRIVATE KEY-----"
        with self.assertRaises(PacketError):
            create_packet(candidate)

    def test_serialized_packet_rejects_malformed_json(self):
        with self.assertRaises(PacketError):
            parse_packet("not json")
        with self.assertRaises(PacketError):
            parse_packet('{"schema_version":1,"schema_version":1}')
        packet = create_packet(payload())
        text = serialize_packet(packet)
        self.assertEqual(hashlib.sha256(canonical_json({k: v for k, v in packet.items() if k != "integrity_sha256"}).encode()).hexdigest(), packet["integrity_sha256"])
        obj = json.loads(text)
        obj["provenance"]["method"] = "unknown-source"
        with self.assertRaises(PacketError):
            serialize_packet(obj)


if __name__ == "__main__":
    unittest.main()
