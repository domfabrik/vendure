"""Package the accepted local artifacts without generation or text normalization.

Usage: python scripts/build-description-sol-crewai-bundle.py --workspace-root D:/work/hobby/fabric
The input manifest and original artifacts remain outside this repository. Only
the server bundle contains private provenance; no provider configuration is read.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

MANIFEST = ".local/product-text-v2/sol-vs-crewai-104/final-20261015/pairs-manifest.json"
MANIFEST_SHA = "0fe501a6aadec951cba7cfc1433ff647152d43ed5707835a2cbddbf1adb761c8"
KEY = "description-sol-vs-crewai-20261014-v1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace-root", type=Path, required=True)
    args = parser.parse_args()
    data_dir = Path(__file__).resolve().parents[1] / "packages/fabric-server/description-study/data"
    raw = (args.workspace_root / MANIFEST).read_bytes()
    assert sha(raw) == MANIFEST_SHA, "Accepted manifest changed"
    manifest = json.loads(raw)
    assert manifest["bundle_complete"] and manifest["pair_count"] == 104
    pairs = manifest["pairs"]
    assert len(pairs) == len({pair["product_id"] for pair in pairs}) == 104
    assert "1403" not in {pair["product_id"] for pair in pairs}
    legacy = json.loads((data_dir / "candidates.v1.json").read_bytes())
    legacy_cases = {case["sourceProductId"]: case for case in legacy["cases"]}
    cases = []
    for pair in pairs:
        case = dict(legacy_cases[pair["product_id"]])
        assert case["slug"] == pair["slug"]
        for side, field in [("a", "old"), ("b", "new")]:
            text_bytes = (args.workspace_root / pair[f"{side}_ref"]).read_bytes()
            assert sha(text_bytes) == pair[f"{side}_sha256"], pair["product_id"]
            text = text_bytes.decode("utf-8")
            assert not text.startswith("\ufeff")
            assert "\r" not in (text if side == "a" else text.replace("\r\n", ""))
            case[f"{field}Text"] = text
            case[f"{field}Hash"] = sha(text_bytes)
            case[f"{field}VersionId"] = f"{KEY}:{field}:{pair['product_id']}:{sha(text_bytes)}"
        case["oldEmpty"] = False
        assert case["oldText"] and case["newText"]
        case["generationMetadata"] = {
            "acceptedManifestRef": MANIFEST,
            "acceptedManifestSha256": MANIFEST_SHA,
            "acceptedPair": pair,
            "textEncoding": "UTF-8; exact original bytes; A LF; B LF or CRLF; no normalization",
            "sharedEvidenceExperimentKey": legacy["experimentKey"],
            "sharedEvidenceSourceProductId": case["sourceProductId"],
        }
        cases.append(case)
    cases.sort(key=lambda case: case["slug"])
    for index, case in enumerate(cases):
        case["ordinal"] = (index + 1) * 3
    bundle = {
        "schemaVersion": 1,
        "experimentKey": KEY,
        "title": "Слепое сравнение описаний: раунд 104",
        "sourceSnapshotSha256": MANIFEST_SHA,
        "sourceCapturedAt": legacy["sourceCapturedAt"],
        "sourceOrigin": "https://domfabrik.ru",
        "selectionRule": "Accepted successful old final cohort, excluding 1403 by user decision; exact manifest SHA256",
        "totalPublished": legacy["totalPublished"],
        "selectedTotal": 104,
        "generationComplete": True,
        "cases": cases,
    }
    target = data_dir / "candidates.sol-crewai-104.v1.json"
    target.write_bytes((json.dumps(bundle, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    # Match the runtime canonicalizer, including JavaScript number serialization
    # in the archived stage usage metadata (Python formats small floats differently).
    digest_script = """
const fs = require('node:fs'), crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).cases;
const canonical = x => Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
  : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'
  : JSON.stringify(x);
process.stdout.write(crypto.createHash('sha256').update(canonical(value)).digest('hex'));
"""
    cases_digest = subprocess.check_output(["node", "-e", digest_script, str(target)], text=True)
    print(json.dumps({"cases": len(cases), "casesSha256": cases_digest, "bundleSha256": sha(target.read_bytes())}))


if __name__ == "__main__":
    main()
