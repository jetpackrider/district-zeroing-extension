"""Stage the published files of every built state for static hosting (GitHub Pages).

Writes <out>/v1/<STATE>/manifest.json and the objects each manifest references, after checking
every object's size and SHA-256. Fixtures and audit reports are left out.

    uv run publish_pages.py /path/to/site            # all built states
    uv run publish_pages.py /path/to/site NY NJ      # some
"""
import argparse
import json
from pathlib import Path
import shutil

from format import file_matches
from inputs import ROOT, STATES

VERSION = "v1"


def stage(state, out):
    directory = ROOT.parent / "data" / state
    manifest_data = (directory / "manifest.json").read_bytes()
    manifest = json.loads(manifest_data)
    if manifest["state"] != state or manifest["stateFips"] != STATES[state] or manifest["format"] != 1:
        raise ValueError(f"{state}: manifest does not describe this state or a supported format")
    refs = [manifest["attrs"], *(manifest[key] for key in ("water", "towns", "points", "names", "outlines") if key in manifest), *manifest["counties"]]
    target = out / VERSION / state
    target.mkdir(parents=True, exist_ok=True)
    total = 0
    for ref in refs:
        source = directory / ref["file"]
        if not file_matches(source, ref):
            raise ValueError(f"{state}: size or SHA-256 mismatch for {ref['file']}")
        shutil.copyfile(source, target / ref["file"])
        total += ref["bytes"]
    (target / "manifest.json").write_bytes(manifest_data)
    return len(refs), total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("states", type=str.upper, nargs="*", metavar="STATE")
    args = parser.parse_args()
    states = args.states or [s for s in STATES if (ROOT.parent / "data" / s / "manifest.json").exists()]
    files = size = 0
    for state in states:
        count, total = stage(state, args.out)
        files += count
        size += total
        print(f"{state}: {count} files, {total / 2**20:.1f} MiB")
    (args.out / ".nojekyll").write_text("")
    print(f"{len(states)} states, {files} files, {size / 2**20:.1f} MiB -> {args.out / VERSION}")


if __name__ == "__main__":
    main()
