"""Run one state process at a time and keep a durable audit ledger."""
import fcntl
import json
import subprocess
import sys
import time

from format import atomic_write, file_matches
from inputs import ROOT, sha256

DATA = ROOT.parent / "data"
LEDGER = ROOT / "state-results.json"
LOG = ROOT / "build-all.log"


def json_file(path):
    return json.loads(path.read_bytes()) if path.is_file() else {}


def bundle_signature(directory, districts):
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = json_file(manifest_path)
        refs = [manifest["attrs"], *manifest["counties"]]
        refs.extend(manifest[key] for key in ("water", "towns", "points", "names", "outlines") if key in manifest)
        if not all(file_matches(directory / ref["file"], ref) for ref in refs):
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    fixture = None
    if districts > 1:
        path = directory / "fixtures" / "cd119.csv"
        if not path.is_file():
            return None
        fixture = sha256(path)
    return {"manifest": sha256(manifest_path), "fixture": fixture}


def state_command(command, state, log):
    print(f"{state} {command} · see {LOG.relative_to(ROOT.parent)}", flush=True)
    print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} {state} {command} ===", file=log, flush=True)
    result = subprocess.run([sys.executable, "-u", str(ROOT / "build.py"), command, state],
                            stdout=log, stderr=subprocess.STDOUT)
    print(f"=== {state} {command} exited {result.returncode} ===", file=log, flush=True)
    return result.returncode


def validation_differences(audit):
    fields = {key: audit.get(key) for key in ["blockCsv", "precinctIds", "precinctPopulations"]}
    fields["inStateGraph"] = audit.get("graph", {}).get("inState")
    differences = {key: result for key, result in fields.items()
                   if result and any(result[name] for name in ("missing", "extra", "unequal"))}
    counts = audit.get("counts", {})
    if counts.get("unhashedRookTouches"):
        differences["unhashedRookTouches"] = {
            "count": counts["unhashedRookTouches"], "examples": counts["unhashedRookExamples"]}
    if ("blockAdjustedColumn" in counts and "precinctAdjustedColumn" in counts
            and counts["blockAdjustedColumn"] != counts["precinctAdjustedColumn"]):
        differences["adjustedColumn"] = {key: counts[key]
                                         for key in ("blockAdjustedColumn", "precinctAdjustedColumn")}
    return differences


def run_batch(states, revalidate):
    (ROOT / "cache").mkdir(exist_ok=True)
    with (ROOT / "cache" / ".build-all.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return run_states(dict.fromkeys(states), revalidate)


def run_states(states, revalidate):
    ledger = json_file(LEDGER)
    failed = False
    with LOG.open("a", encoding="utf-8") as log:
        for state in states:
            directory = DATA / state
            prior = ledger.get(state, {})
            signature = bundle_signature(directory, prior.get("cd119Districts", 0))
            if not revalidate and signature and prior.get("result") == "passed" and signature == prior.get("files"):
                print(f"{state} already validated", flush=True)
                continue
            build_code = None
            validate_code = None
            if signature:
                validate_code = state_command("validate", state, log)
            if not signature or validate_code == 2 and state != "NY":
                build_code = state_command("build", state, log)
                if build_code == 0:
                    validate_code = state_command("validate", state, log)
            built = json_file(directory / "build-audit.json") if build_code in (None, 0, 2) else {}
            validated = json_file(directory / "validation.json") if validate_code in (0, 1, 2) else {}
            audit = validated if validate_code is not None and build_code in (0, None) else built
            result = "passed" if validate_code == 0 else "failed"
            failed |= result == "failed"
            districts = audit.get("cd119Districts", 0)
            ledger[state] = dict(result=result, buildExitCode=build_code, validationExitCode=validate_code,
                                 precinctKind=audit.get("precinctKind"), counts=audit.get("counts"),
                                 cd119Districts=districts, bundle=audit.get("bundle") or built.get("bundle"),
                                 buildSeconds=built.get("seconds"), validateSeconds=validated.get("seconds"),
                                 buildPeakPythonRSSBytes=built.get("peakPythonRSSBytes"),
                                 buildPeakChildRSSBytes=built.get("peakChildRSSBytes"),
                                 validationPeakPythonRSSBytes=validated.get("peakPythonRSSBytes"),
                                 differences=validation_differences(audit),
                                 error=audit.get("error") or (f"State build process exited {build_code}"
                                                            if build_code is not None and build_code < 0 else
                                                            f"Validation process exited {validate_code}"
                                                            if validate_code is not None and validate_code < 0 else None),
                                 files=bundle_signature(directory, districts) if result == "passed" else None,
                                 audit=str((directory / ("validation.json" if audit is validated else "build-audit.json"))
                                           .relative_to(ROOT.parent)))
            atomic_write(LEDGER, (json.dumps(ledger, indent=2) + "\n").encode())
            print(f"{state} {result}", flush=True)
    return int(failed)
