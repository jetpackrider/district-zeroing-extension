"""Upload the active state manifest and its referenced objects using AWS CLI v2."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from format import file_matches
from inputs import ROOT, STATES

IMMUTABLE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "public, max-age=300, must-revalidate"


def upload(state, bucket, endpoint):
    directory = ROOT.parent / "data" / state
    manifest_file = directory / "manifest.json"
    # Keep the exact manifest snapshot in case another build publishes during upload.
    manifest_data = manifest_file.read_bytes()
    manifest = json.loads(manifest_data)
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError("Manifest does not describe the requested state or supported format")
    objects = [(manifest["attrs"], "attrs", ".bin.gz")]
    for sidecar in ("water", "towns"):
        if sidecar in manifest:
            objects.append((manifest[sidecar], sidecar, ".bin.gz"))
    for county in manifest["counties"]:
        if re.fullmatch(STATES[state] + r"[0-9]{3}", county["fips"]) is None:
            raise ValueError("Invalid county FIPS in manifest")
        objects.append((county, county["fips"], ".topo.json.gz"))
    if len({ref["file"] for ref, _, _ in objects}) != len(objects):
        raise ValueError("Duplicate objects in manifest")
    for ref, prefix, extension in objects:
        digest = ref["sha256"]
        if re.fullmatch(r"[a-f0-9]{64}", digest) is None or ref["file"] != f"{prefix}.{digest}{extension}":
            raise ValueError("Unversioned or invalid object name")
        if not file_matches(directory / ref["file"], ref):
            raise ValueError(f"Local size or SHA-256 mismatch: {ref['file']}")

    aws = ["aws", "--no-cli-pager", "--endpoint-url", endpoint, "--region", "auto", "s3api"]
    for ref, _, _ in objects:
        key = f"{state}/{ref['file']}"
        command = ["--bucket", bucket, "--key", key]
        result = subprocess.run([*aws, "put-object", *command, "--body", str(directory / ref["file"]),
                                 "--if-none-match", "*", "--content-type", "application/gzip",
                                 "--cache-control", IMMUTABLE, "--metadata", f"sha256={ref['sha256']}"],
                                capture_output=True, text=True)
        if result.returncode:
            existing = subprocess.run([*aws, "head-object", *command, "--output", "json"],
                                      capture_output=True, text=True)
            header = json.loads(existing.stdout) if existing.returncode == 0 else {}
            if (header.get("ContentLength") != ref["bytes"]
                    or header.get("Metadata", {}).get("sha256") != ref["sha256"]
                    or header.get("CacheControl") != IMMUTABLE
                    or header.get("ContentType") != "application/gzip"
                    or header.get("ContentEncoding") is not None):
                raise RuntimeError(f"R2 write failed for {key}: {result.stderr.strip()}")
        print(key)

    with tempfile.NamedTemporaryFile(suffix=".json") as snapshot:
        snapshot.write(manifest_data)
        snapshot.flush()
        subprocess.run([*aws, "put-object", "--bucket", bucket, "--key", f"{state}/manifest.json",
                        "--body", str(Path(snapshot.name)), "--content-type", "application/json",
                        "--cache-control", MANIFEST_CACHE], check=True, stdout=subprocess.DEVNULL)
    print(f"{state}/manifest.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=str.upper, choices=STATES)
    parser.add_argument("--bucket", default=os.getenv("ZD_R2_BUCKET"), help="R2 bucket, or ZD_R2_BUCKET")
    parser.add_argument("--account-id", default=os.getenv("ZD_R2_ACCOUNT_ID"), help="R2 account, or ZD_R2_ACCOUNT_ID")
    args = parser.parse_args()
    if not args.bucket or not args.account_id or re.fullmatch(r"[a-fA-F0-9]{32}", args.account_id) is None:
        parser.error("Provide a bucket and a 32-character hexadecimal account ID")
    upload(args.state, args.bucket, f"https://{args.account_id}.r2.cloudflarestorage.com")


if __name__ == "__main__":
    main()
