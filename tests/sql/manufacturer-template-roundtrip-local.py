"""Persist/reload the real local Scion artifact without provider or production access."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys

DB = sys.argv[1]
if not re.fullmatch(r"sideflip_manufacturer_template_test_[0-9]+", DB):
    raise SystemExit("Refusing non-disposable database name")
ROOT = Path(__file__).resolve().parents[2]
template = json.loads((ROOT / "tests/fixtures/scion-2012-xd-template.json").read_text())
OWNER = "11111111-1111-4111-8111-111111111111"

def sql(query, role="service_role", expect_failure=False):
    prefix = f"set role {role}; set request.jwt.claim.sub='{OWNER}'; "
    result = subprocess.run(["sudo", "-u", "postgres", "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", DB],
                            input=prefix + query, text=True, capture_output=True)
    if expect_failure:
        assert result.returncode != 0 and "identity mismatch" in result.stderr, result.stderr
        return ""
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()

def literal(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"

record = {
    "template_key": template["templateId"], "version": 1,
    "source_sha256": template["source"]["sha256"],
    "source_document_id": template["source"]["id"],
    "source_version": template["source"]["version"], "source_url": None,
    "source_authenticity": "user_uploaded_unverified", "source_authenticity_evidence": None,
    "schema_version": "manufacturer-template-v1", "validator_version": None,
    "applicability": template["applicability"], "applicability_reviewed": False,
    "status": "needs_review", "validation_report": {"passed": False, "reason": "Round-trip test does not assert semantic review"},
    "payload": template,
}
query = f"select public.store_manufacturer_template_version('{OWNER}',{literal(record)});"
first_id = sql(query)
assert first_id == sql(query), "Real-payload replay created a second version"
reloaded = json.loads(sql(f"select record from public.manufacturer_template_versions where id='{first_id}';", "authenticated"))
assert reloaded == record, "Payload or provenance lost during database round trip"
assert reloaded["payload"]["applicability"]["engine"] is None
assert reloaded["source_authenticity"] == "user_uploaded_unverified"
for path, value in [("source_sha256", "c" * 64), ("source_document_id", "wrong-source"),
                    ("source_version", "wrong-version"), ("applicability", {**template["applicability"], "year": 2013})]:
    forged = copy.deepcopy(record)
    forged[path] = value
    sql(f"select public.store_manufacturer_template_version('{OWNER}',{literal(forged)});", expect_failure=True)
assert sql(f"select count(*) from public.find_my_manufacturer_templates({literal(template['applicability'])}) where id='{first_id}';", "authenticated") == "0", "Unreviewed real template leaked into matching"
print(json.dumps({"result": "PASS", "real_scion_payload_roundtrip": True, "rules": len(template["rules"]),
                  "evidence": len(template["evidence"]), "source_sha256": template["source"]["sha256"],
                  "owner_private": True, "status": reloaded["status"], "metadata_mismatch_rejected": True}))
